import { expect, test } from "@playwright/test";
import { launchApp } from "./launch";

// Smoke test only: the host closes in a few milliseconds, so it also finishes when quitting does
// not wait for it. The wait in main.ts guards a race that a test cannot force; see coverage-map.md.
test("leaves the host's final log record on disk after quitting", async () => {
  const launched = await launchApp();

  await launched.quit();
  const log = await launched.readHostLog();

  expect(log.at(-1)).toMatchObject({ msg: "host stopped" });
  await launched.cleanup();
});
