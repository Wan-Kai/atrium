import type { Page } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";

/** The parts of a V8 heap snapshot file the leak check reads. */
interface HeapSnapshotFile {
  readonly snapshot: {
    readonly meta: { readonly node_fields: string[]; readonly node_types: [string[], ...unknown[]] };
  };
  readonly nodes: number[];
  readonly strings: string[];
}

/** Detached DOM nodes of one kind whose number grew during the scenario. */
export interface DetachedGrowth {
  /** Node description as Chromium writes it, such as `<div class="row">`. */
  readonly name: string;
  readonly before: number;
  readonly after: number;
}

/** V8's `detachedness` value for a DOM node that is no longer in any document. */
const DETACHED = 2;

/**
 * Forces garbage collection in the page and writes a heap snapshot to `file`.
 *
 * @remarks
 * Snapshots are taken over CDP so the real Electron renderer is measured, not a separate browser
 * (testing.md, "界面泄漏测试"). First the page draws two frames (`settleFrames`): Chromium's
 * document timeline can keep the CSS animations of an element removed since the last frame, and
 * with them the element, until a frame services the timeline. A running mark (21 animated dots)
 * removed just before the snapshot otherwise counts as detached DOM nothing in the app holds.
 *
 * @sideEffects Waits for two frames in the page; opens a CDP session on the page, runs GC, and
 * writes the snapshot file.
 * @param page - The renderer page.
 * @param file - Where to write the `.heapsnapshot`.
 */
export async function takeHeapSnapshot(page: Page, file: string): Promise<void> {
  await settleFrames(page);
  const cdp = await page.context().newCDPSession(page);
  const chunks: string[] = [];
  cdp.on("HeapProfiler.addHeapSnapshotChunk", ({ chunk }) => chunks.push(chunk));
  await cdp.send("HeapProfiler.enable");
  await cdp.send("HeapProfiler.collectGarbage");
  await cdp.send("HeapProfiler.takeHeapSnapshot", { reportProgress: false });
  await cdp.detach();
  await writeFile(file, chunks.join(""));
}

/**
 * Waits until the page has drawn two whole frames.
 *
 * @remarks
 * A frame services the document timeline before it runs animation-frame callbacks, and an element
 * removed since may have its animations cancelled only in that frame's style pass; the next frame's
 * service drops them. Two callbacks are the least that covers both, wherever in a frame the call
 * lands.
 *
 * @sideEffects Schedules two animation-frame callbacks in the page.
 * @param page - The renderer page.
 */
async function settleFrames(page: Page): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  );
}

/**
 * Lists kinds of detached DOM node that are more numerous in `final` than in `baseline`.
 *
 * @remarks
 * A DOM node that was removed from the page but is still referenced is the classic UI leak, and
 * it also covers React: an unmounted component that is still retained keeps its DOM alive.
 * Chromium marks such nodes with the snapshot's `detachedness` field instead of a "Detached"
 * name prefix, which memlab 2.0.5 does not understand, so this reads the field directly. Native
 * node ids are not stable across snapshots, so nodes are compared by count per name rather than
 * by id; any growth after the scenario means it left detached DOM behind.
 *
 * @sideEffects Reads both snapshot files.
 * @param baselineFile - Snapshot taken before the scenario.
 * @param finalFile - Snapshot taken after the scenario finished and cleaned up.
 * @returns One entry per node kind that grew, empty when nothing leaked.
 */
export async function findDetachedDomLeaks(baselineFile: string, finalFile: string): Promise<DetachedGrowth[]> {
  const before = await readDetachedDomCounts(baselineFile);
  const after = await readDetachedDomCounts(finalFile);
  return [...after.entries()]
    .filter(([name, count]) => count > (before.get(name) ?? 0))
    .map(([name, count]) => ({ name, before: before.get(name) ?? 0, after: count }));
}

/**
 * Reads the number of detached DOM nodes of each kind in one snapshot.
 *
 * @remarks
 * A warmed baseline can already contain a leak. Callers checking disposable resources such as
 * Mermaid's drawing containers need an absolute zero check as well as the growth comparison.
 *
 * @sideEffects Reads the snapshot file.
 * @param file - Heap snapshot to inspect.
 * @returns Counts keyed by Chromium's DOM node description.
 */
export async function readDetachedDomCounts(file: string): Promise<Map<string, number>> {
  return countDetached(await readSnapshot(file));
}

/**
 * Counts detached DOM nodes per node name.
 *
 * @remarks
 * DOM nodes are the snapshot's `native` nodes; only those V8 marks as detached are counted.
 *
 * @sideEffects none
 * @param nodes - Decoded snapshot nodes.
 * @returns Count per node name.
 */
function countDetached(
  nodes: ReadonlyArray<{ type: string; name: string; detachedness: number }>,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const node of nodes) {
    if (node.type === "native" && node.detachedness === DETACHED)
      counts.set(node.name, (counts.get(node.name) ?? 0) + 1);
  }
  return counts;
}

/**
 * Decodes the flat node array of a heap snapshot.
 *
 * @remarks
 * The file stores nodes as a flat number array described by `meta.node_fields`; decoding by field
 * name keeps this working if V8 adds or reorders fields.
 *
 * @sideEffects Reads the file.
 * @param file - Snapshot path.
 * @returns Every node with its type, name and detachedness.
 */
async function readSnapshot(file: string): Promise<Array<{ type: string; name: string; detachedness: number }>> {
  const snapshot = JSON.parse(await readFile(file, "utf8")) as HeapSnapshotFile;
  const fields = snapshot.snapshot.meta.node_fields;
  const types = snapshot.snapshot.meta.node_types[0];
  const [typeAt, nameAt, detachedAt] = ["type", "name", "detachedness"].map((name) => fields.indexOf(name));
  const nodes = [];
  for (let offset = 0; offset < snapshot.nodes.length; offset += fields.length) {
    const [type, name, detachedness] = [typeAt, nameAt, detachedAt].map(
      (index) => snapshot.nodes[offset + (index ?? -1)] ?? -1,
    );
    nodes.push({
      type: types[type ?? -1] ?? "unknown",
      name: snapshot.strings[name ?? -1] ?? "",
      detachedness: detachedness ?? -1,
    });
  }
  return nodes;
}
