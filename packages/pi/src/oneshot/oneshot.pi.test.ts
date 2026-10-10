import { FAUX_MODEL, FAUX_PROVIDER, type FauxScript, createTempDir, fauxPi, present } from "@atrium/testkit";
import { chmod, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PiDeps } from "../deps";
import { findPi } from "../locate/locate";
import { OneShotError, runOneShot } from "./oneshot";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

/**
 * Runs a one-shot call against the real pi answering from the faux model.
 *
 * @remarks
 * A wrapper adds the faux extension's arguments after the call's own, as the end-to-end tests'
 * wrapper does, so the call runs pi exactly as the host would. Only `PATH` comes from the machine,
 * so no credentials of the user's reach pi.
 *
 * @sideEffects Creates a temporary directory, removed after the test; runs pi.
 * @param script - What the faux model answers.
 * @returns The text, or the error.
 */
async function oneShot(script: FauxScript) {
  const dir = await createTempDir("oneshot-pi");
  cleanups.push(dir.cleanup);
  const home = await realpath(dir.path);
  const launch = await fauxPi(script, home);
  const pi = present(await findPi(present(process.env["PATH"], "PATH")), "pi");
  const wrapper = join(home, "pi");
  const quoted = launch.args.map((arg) => `'${arg}'`).join(" ");
  await writeFile(wrapper, `#!/bin/sh\nexec '${pi}' "$@" ${quoted}\n`);
  await chmod(wrapper, 0o755);
  const deps: PiDeps = {
    clock: {
      now: () => Date.now(),
      setTimeout(callback, ms) {
        const timer = setTimeout(callback, ms);
        return () => clearTimeout(timer);
      },
    },
    track: () => () => undefined,
    log: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
    nextRequestId: () => "unused",
    env: { PATH: present(process.env["PATH"], "PATH"), HOME: home, TMPDIR: tmpdir() },
  };
  return runOneShot(
    {
      piPath: wrapper,
      cwd: home,
      env: launch.env,
      model: { providerId: FAUX_PROVIDER, modelId: FAUX_MODEL },
      systemPrompt: "Name the conversation.",
      input: "User: fix the login bug",
    },
    deps,
  ).then(
    (text) => ({ text }),
    (error: unknown) => ({ error }),
  );
}

describe("runOneShot against pi", () => {
  it("gets the reply's text from pi's print mode", async () => {
    expect(await oneShot({ replies: [], title: "登录修复" })).toStrictEqual({ text: "登录修复" });
  });

  it("fails when the model fails", async () => {
    expect(await oneShot({ replies: [] })).toStrictEqual({ error: new OneShotError("model_failed") });
  });
});
