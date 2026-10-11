import { expect, test } from "@playwright/test";
import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { launchApp } from "./launch";

const run = promisify(execFile);
/** Where `pnpm package` puts the app for this machine. */
const bundle = join(import.meta.dirname, "..", "out", `Atrium-darwin-${process.arch}`, "Atrium.app");

test("@package runs from the packaged app, with the host, login program and UI inside it", async () => {
  await run("codesign", ["--verify", "--deep", "--strict", bundle]);
  const launched = await launchApp({}, undefined, { executablePath: join(bundle, "Contents", "MacOS", "Atrium") });

  try {
    const where = await launched.app.evaluate(({ app }) => ({
      packaged: app.isPackaged,
      name: app.getName(),
      appPath: app.getAppPath(),
    }));
    const appDir = join(bundle, "Contents", "Resources", "app");
    expect(where).toStrictEqual({ packaged: true, name: "Atrium", appPath: appDir });
    expect(launched.window.url()).toBe("atrium://app/");
    await access(join(appDir, "host", "login-worker.mjs"));
    await launched.quit();

    expect((await launched.readHostLog()).at(-1)).toMatchObject({ msg: "host stopped" });
  } finally {
    await launched.cleanup();
  }
});
