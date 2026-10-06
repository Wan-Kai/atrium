import { expect, test } from "@playwright/test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchApp } from "./launch";

const repo = join(import.meta.dirname, "..", "..", "..");

test("leaves the host's final log record on disk after quitting", async () => {
  const launched = await launchApp();

  await launched.quit();
  const log = await launched.readHostLog();

  expect(log.at(-1)).toMatchObject({ msg: "host stopped" });
  await launched.cleanup();
});

test("waits for a host that is slow to exit before quitting", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atrium-slow-exit-"));
  const marker = join(dir, "exited");
  const launched = await launchApp({
    ATRIUM_HOST_ENTRY: join(import.meta.dirname, "slow-exit-host.cjs"),
    ATRIUM_REAL_HOST_ENTRY: join(repo, "packages", "host", "dist", "entry.cjs"),
    ATRIUM_TEST_EXIT_MARKER: marker,
  });

  try {
    await launched.quit();

    expect(await readFile(marker, "utf8")).toBe("0");
    expect((await launched.readHostLog()).at(-1)).toMatchObject({ msg: "host stopped" });
  } finally {
    await launched.cleanup();
    await rm(dir, { recursive: true, force: true });
  }
});
