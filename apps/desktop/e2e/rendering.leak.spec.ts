import { expect, test } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxPiEnvironment } from "./faux-pi";
import { findDetachedDomLeaks, takeHeapSnapshot } from "./heap";
import { launchApp } from "./launch";
import { send } from "./messages";

const REPLY =
  "```plantuml\n@startuml\nAlice -> Bob: hello\n@enduml\n```\n\n![图](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=)";

/** Records real diagram URLs without substituting creation or revocation.
 * @remarks Resource accounting supplements the detached-DOM heap check.
 * @sideEffects Wraps two URL methods in this isolated test window.
 */
function trackDiagramUrls(): void {
  const active = new Set<string>();
  Object.defineProperty(window, "__atriumDiagramUrls", { value: active });
  const create = URL.createObjectURL.bind(URL);
  const revoke = URL.revokeObjectURL.bind(URL);
  /** Creates the real URL and records diagrams.
   * @remarks Other browser blobs do not belong to this feature.
   * @sideEffects Creates a URL and records it.
   * @param object - The real browser source.
   * @returns The real URL.
   */
  URL.createObjectURL = (object) => {
    const url = create(object);
    if (object instanceof Blob && object.type === "image/svg+xml") active.add(url);
    return url;
  };
  /** Revokes the real URL and removes its accounting entry.
   * @remarks The wrapper never makes cleanup happen on behalf of the implementation.
   * @sideEffects Revokes a URL and updates the count.
   * @param url - The URL being released.
   */
  URL.revokeObjectURL = (url) => {
    active.delete(url);
    revoke(url);
  };
}

/** Reads the test-only URL count from the page.
 * @remarks A missing instrument must fail rather than look like zero resources.
 * @sideEffects none
 * @returns The number of live diagram URLs.
 */
function activeDiagramUrls(): number {
  const active: unknown = Reflect.get(window, "__atriumDiagramUrls");
  if (!(active instanceof Set)) throw new Error("missing instrumentation");
  return active.size;
}

test("@leak switching diagram sessions and opening fullscreen images releases workers, Blob URLs and DOM", async () => {
  const pi = await fauxPiEnvironment({ replies: [{ blocks: [{ type: "text", text: REPLY }] }] });
  const launched = await launchApp(pi.env);
  const dir = await mkdtemp(join(tmpdir(), "atrium-rendering-heap-"));
  try {
    const { window } = launched;
    await window.evaluate(trackDiagramUrls);
    const tabs = window.getByRole("tab");
    const diagram = window.getByTestId("reply").locator('img[alt="PlantUML 图表"]');
    await send(window, "一");
    await expect.poll(() => diagram.evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    await window.keyboard.press("Meta+T");
    await expect(tabs).toHaveCount(2);
    await send(window, "二");
    await expect.poll(() => diagram.evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    /** Exercises real unmounts, completed worker cleanup and native dialog teardown.
     * @remarks Waiting for each diagram ensures every tab switch actually did the work.
     * @sideEffects Switches sessions and opens/closes previews.
     * @param text - The session's title.
     */
    const show = async (text: string): Promise<void> => {
      await tabs.filter({ hasText: text }).click();
      await expect.poll(() => diagram.evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
      await window.getByRole("button", { name: "放大图片：图" }).click();
      await expect(window.getByRole("dialog", { name: "图片预览" })).toContainText("1 × 1");
      await window.keyboard.press("Escape");
      await expect(window.locator("dialog")).toHaveCount(0);
      await expect
        .poll(() => window.workers().filter((worker) => worker.url().includes("plantuml.worker")).length)
        .toBe(0);
      await expect.poll(() => window.evaluate(activeDiagramUrls)).toBe(1);
    };
    await show("一");
    await show("二");
    await takeHeapSnapshot(window, join(dir, "baseline.heapsnapshot"));
    for (let round = 0; round < 10; round += 1) {
      await show("一");
      await show("二");
    }
    await takeHeapSnapshot(window, join(dir, "final.heapsnapshot"));
    expect(
      await findDetachedDomLeaks(join(dir, "baseline.heapsnapshot"), join(dir, "final.heapsnapshot")),
    ).toStrictEqual([]);
  } finally {
    await launched.close();
    await pi.cleanup();
    await rm(dir, { recursive: true, force: true });
  }
});
