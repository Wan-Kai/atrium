import { expect, type Page, test } from "@playwright/test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findDetachedDomLeaks, takeHeapSnapshot } from "./heap";
import { launchApp } from "./launch";
import { fauxPiEnvironment } from "./faux-pi";
import { installPhoneTestVault } from "./phone-test-vault";
import { observePhoneWire, type PhoneWire, type PhonePairMark } from "./phone-wire";
import { startRelay } from "../../relay/src/relay";
import { systemClock } from "../../relay/src/clock";
import { ResourceTracker } from "../../relay/src/resources";
import { newCredentials, hashToken } from "../../relay/src/hosts";

/**
 * Visits the phone page twice through the real settings window, then closes it.
 *
 * @remarks
 * Switching categories exercises content unmounts separately from the window-owned remote watch.
 * Remote access stays disabled in the isolated home; no relay credentials or keychain access are needed.
 *
 * @sideEffects Clicks settings controls and waits for authoritative remote state to render.
 * @param page - The isolated Electron renderer.
 * @returns When settings and phone content have unmounted.
 */
async function cyclePhoneSettings(page: Page): Promise<void> {
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "设置", exact: true });
  await settings.getByRole("button", { name: "手机", exact: true }).click();
  const phone = settings.getByRole("region", { name: "手机设置", exact: true });
  await expect(phone.getByRole("heading", { name: "接上你的 relay", exact: true })).toBeVisible();

  await settings.getByRole("button", { name: "关于", exact: true }).click();
  await expect(phone).toHaveCount(0);
  await expect(settings.getByRole("heading", { name: "关于", exact: true })).toBeVisible();
  await settings.getByRole("button", { name: "手机", exact: true }).click();
  await expect(phone.getByRole("heading", { name: "接上你的 relay", exact: true })).toBeVisible();
  await settings.getByRole("button", { name: "关闭设置", exact: true }).click();
  await expect(settings).toHaveCount(0);
}

/** Checks real watch commands and their acknowledgements. @remarks The expected sequence comes from UI actions, not observed counts. @sideEffects Polls metadata. */
async function expectPhoneWatches(wire: PhoneWire, expected: readonly boolean[]): Promise<void> {
  await expect
    .poll(() => wire.commands.filter((mark) => mark.type === "get_remote").map((mark) => [mark.watch, mark.ok]))
    .toStrictEqual(expected.map((watch) => [watch, true]));
}

/**
 * Exercises category unmount and window unmount while the same QR remains active on the host.
 * @remarks Pointer navigation is real; Meta+, closes the parent without Escape's pairing cancellation.
 * @sideEffects Navigates UI, awaiting the actual watch protocol and absence of unmounted DOM.
 * @param page - The renderer.
 * @param wire - Metadata-only CDP recorder.
 * @param watches - Expected window ownership transitions, updated independently of observed frames.
 * @param pairing - Original non-secret pairing identity/deadline.
 */
async function cycleAvailableQr(
  page: Page,
  wire: PhoneWire,
  watches: boolean[],
  pairing: PhonePairMark,
): Promise<void> {
  await page.keyboard.press("Meta+,");
  watches.push(true);
  const settings = page.getByRole("dialog", { name: "设置", exact: true });
  const qr = page.getByRole("img", { name: "一次性配对二维码", exact: true });
  await expect(qr).toBeVisible();
  await expectPhoneWatches(wire, watches);
  expect(wire.pairing).toStrictEqual(pairing);
  await settings.getByRole("button", { name: "关于", exact: true }).click();
  await expect(page.getByRole("region", { name: "手机设置", exact: true })).toHaveCount(0);
  await expect(page.getByRole("dialog", { name: "配对新设备", exact: true })).toHaveCount(0);
  await expect(qr).toHaveCount(0);
  await expectPhoneWatches(wire, watches);
  await settings.getByRole("button", { name: "手机", exact: true }).click();
  await expect(qr).toBeVisible();
  // Sensitivity control insertion point: retain this real QR only in a temporary negative-control copy.
  await page.keyboard.press("Meta+,");
  watches.push(false);
  await expect(settings).toHaveCount(0);
  await expect(qr).toHaveCount(0);
  await expect(page.getByRole("dialog", { name: "配对新设备", exact: true })).toHaveCount(0);
  await expectPhoneWatches(wire, watches);
  expect(wire.pairing).toStrictEqual(pairing);
  expect(wire.connected).toBe(true);
}

/** Requires the built repository paths. @remarks Inherited overrides could point outside this isolated test. @sideEffects none @throws When overrides exist. */
function requireLocalPhoneBuild(): void {
  if (process.env["ATRIUM_DEV_URL"] !== undefined || process.env["ATRIUM_HOST_ENTRY"] !== undefined)
    throw new Error("phone e2e requires the repository's built UI and host, without inherited overrides");
}

/** Captures only pairing metadata. @remarks No QR or SAS enters the assertion baseline. @sideEffects none @throws When pairing is missing. */
function availablePairing(wire: PhoneWire): PhonePairMark {
  const pairing = wire.pairing;
  if (pairing === null || !pairing.available) throw new Error("available pairing metadata missing");
  return pairing;
}

/** Records cleanup failures without masking the primary assertion. @remarks Every outer cleanup must still run. @sideEffects Runs resource cleanup and records errors. */
async function collectPhoneCleanup(cleanup: () => Promise<void>, errors: unknown[]): Promise<void> {
  try {
    await cleanup();
  } catch (error) {
    errors.push(error);
  }
}

/** Surfaces all failures after resources are released. @remarks The primary error is kept first. @sideEffects none @throws Any recorded errors. */
function throwPhoneErrors(errors: unknown[]): void {
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "phone QR scenario and cleanup failed");
}

// A distinct test type scopes worker-level recording options without disabling the original case's trace.
const qrTest = test.extend({ trace: "off" as const, screenshot: "off" as const, video: "off" as const });
qrTest.describe("available QR lifecycle", () => {
  qrTest("@leak releases available QR DOM and the window watch without cancelling pairing", async () => {
    qrTest.setTimeout(120_000);
    requireLocalPhoneBuild();
    const directory = await mkdtemp(join(tmpdir(), "atrium-phone-qr-heap-"));
    const errors: unknown[] = [];
    try {
      const faux = await fauxPiEnvironment({ replies: [] });
      try {
        const credentials = newCredentials();
        const resources = new ResourceTracker();
        const relayEvents: string[] = [];
        const relay = await startRelay({
          config: { publicHost: "127.0.0.1", pathPrefix: "", trustedProxies: [], newStreamsPerIpPerMinute: 30 },
          hosts: [
            {
              hostId: credentials.hostId,
              name: "Synthetic phone heap host",
              tokenSha256: hashToken(credentials.token),
              createdAt: "2026-01-01T00:00:00.000Z",
            },
          ],
          listen: { host: "127.0.0.1", port: 0 },
          clock: systemClock,
          resources,
          log: (event) => relayEvents.push(event.event),
        });
        try {
          const launched = await launchApp(faux.env);
          try {
            await installPhoneTestVault(launched.app);
            const page = launched.window;
            const wire = await observePhoneWire(page);
            try {
              // A fresh socket after CDP enable avoids relying on retroactive socket-created events.
              await page.reload();
              await expect(page.getByRole("status")).toHaveText(/已连接宿主/);
              await page.getByRole("button", { name: "设置", exact: true }).click();
              const settings = page.getByRole("dialog", { name: "设置", exact: true });
              await settings.getByRole("button", { name: "手机", exact: true }).click();
              const watches = [true];
              await expectPhoneWatches(wire, watches);
              await page
                .getByLabel("relay 的那一行", { exact: true })
                .fill(`atrium-relay://${credentials.hostId}:${credentials.token}@127.0.0.1:${relay.port}`);
              await page.getByRole("button", { name: "保存并连接", exact: true }).click();
              await expect.poll(() => wire.connected).toBe(true);
              // Never print vault bytes on assertion failure; only a boolean crosses the assertion boundary.
              expect(
                /^e2e-phone-vault:\d+$/.test((await readFile(join(launched.home, "remote", "vault.bin"))).toString()),
              ).toBe(true);
              await page.getByRole("button", { name: "配对新设备", exact: true }).click();
              await expect(page.getByRole("img", { name: "一次性配对二维码", exact: true })).toBeVisible();
              await expect.poll(() => wire.pairing?.available).toBe(true);
              const pairing = availablePairing(wire);
              await page.keyboard.press("Meta+,");
              watches.push(false);
              await expect(settings).toHaveCount(0);
              await expectPhoneWatches(wire, watches);
              for (let cycle = 0; cycle < 2; cycle++) await cycleAvailableQr(page, wire, watches, pairing);
              const baseline = join(directory, "baseline.heapsnapshot");
              const final = join(directory, "final.heapsnapshot");
              await takeHeapSnapshot(page, baseline);
              for (let cycle = 0; cycle < 20; cycle++) await cycleAvailableQr(page, wire, watches, pairing);
              await takeHeapSnapshot(page, final);
              // Native node descriptions may contain SVG attributes; report only counts, never QR paths.
              expect(
                (await findDetachedDomLeaks(baseline, final)).map(({ before, after }) => ({ before, after })),
              ).toStrictEqual([]);
              expect(
                wire.commands.filter((mark) => mark.type !== "get_remote").map((mark) => [mark.type, mark.ok]),
              ).toStrictEqual([
                ["set_remote", true],
                ["start_pairing", true],
              ]);
              expect(relayEvents).toStrictEqual(["host_online"]);
            } finally {
              await collectPhoneCleanup(() => wire.close(), errors);
            }
          } finally {
            await collectPhoneCleanup(() => launched.close(), errors);
          }
        } finally {
          await collectPhoneCleanup(() => relay.close(), errors);
          await collectPhoneCleanup(async () => {
            expect(Object.values(resources.snapshot()).every((count) => count === 0)).toBe(true);
          }, errors);
        }
      } finally {
        await collectPhoneCleanup(() => faux.cleanup(), errors);
      }
    } catch (error) {
      errors.unshift(error);
    } finally {
      await collectPhoneCleanup(() => rm(directory, { recursive: true, force: true }), errors);
    }
    throwPhoneErrors(errors);
  });
});

test("@leak opening phone settings and switching categories releases detached DOM", async () => {
  const directory = await mkdtemp(join(tmpdir(), "atrium-phone-heap-"));
  try {
    const launched = await launchApp();
    try {
      for (let cycle = 0; cycle < 2; cycle++) await cyclePhoneSettings(launched.window);
      const baseline = join(directory, "baseline.heapsnapshot");
      const final = join(directory, "final.heapsnapshot");
      await takeHeapSnapshot(launched.window, baseline);
      for (let cycle = 0; cycle < 20; cycle++) await cyclePhoneSettings(launched.window);
      await takeHeapSnapshot(launched.window, final);
      expect(await findDetachedDomLeaks(baseline, final)).toStrictEqual([]);
    } finally {
      await launched.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
