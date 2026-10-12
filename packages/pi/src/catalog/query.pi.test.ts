import {
  FAUX_BASE_URL_ENV,
  FAUX_MODEL,
  FAUX_PROVIDER,
  createTempDir,
  fauxPi,
  present,
  startModelListServer,
} from "@atrium/testkit";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { PiDeps } from "../deps";
import { findPi } from "../locate/locate";
import { queryModels } from "./query";

/** Atrium's Fast extension, as the host has pi load it (ADR-0008). */
const FAST_EXTENSION = fileURLToPath(new URL("../fast/extension.ts", import.meta.url));

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

/**
 * Dependencies for a real pi whose home is a fresh directory.
 *
 * @remarks
 * Only `PATH` comes from the machine, so no credentials of the user's reach pi.
 *
 * @sideEffects none
 * @param home - pi's home directory.
 * @returns The dependencies.
 */
function isolatedDeps(home: string): PiDeps {
  return {
    clock: {
      now: () => Date.now(),
      setTimeout(callback, ms) {
        const timer = setTimeout(callback, ms);
        return () => clearTimeout(timer);
      },
    },
    track: () => () => undefined,
    log: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
    nextRequestId: (() => {
      let next = 0;
      return () => `q${++next}`;
    })(),
    env: { PATH: present(process.env["PATH"], "PATH"), HOME: home, TMPDIR: tmpdir() },
  };
}

/**
 * A fresh directory that is also pi's home, and pi's path.
 *
 * @remarks
 * Removed after the test.
 *
 * @sideEffects Creates a temporary directory.
 * @returns The directory and pi's path.
 */
async function setUp(): Promise<{ readonly dir: string; readonly piPath: string }> {
  const dir = await createTempDir("query-models-pi");
  cleanups.push(dir.cleanup);
  return { dir: await realpath(dir.path), piPath: present(await findPi(present(process.env["PATH"], "PATH")), "pi") };
}

describe("queryModels against pi", () => {
  it("lists the models of the providers with credentials, with pi's own pick as the default", async () => {
    const { dir, piPath } = await setUp();
    const faux = await fauxPi({ replies: [], models: [{ id: "faux-plain", reasoning: false }] }, dir);

    const list = await queryModels(
      { piPath, args: faux.args, cwd: dir, env: faux.env },
      isolatedDeps(dir),
      new AbortController().signal,
    );

    expect(list.models.map(({ providerId, modelId }) => `${providerId}/${modelId}`)).toStrictEqual([
      `${FAUX_PROVIDER}/${FAUX_MODEL}`,
      `${FAUX_PROVIDER}/faux-plain`,
    ]);
    expect(list.defaultModel).toStrictEqual({ providerId: FAUX_PROVIDER, modelId: FAUX_MODEL });
  });

  it("lists nothing, without a default, when no provider has credentials", async () => {
    const { dir, piPath } = await setUp();

    const list = await queryModels(
      { piPath, args: [], cwd: dir, env: { PI_CODING_AGENT_DIR: join(dir, "pi-agent") } },
      isolatedDeps(dir),
      new AbortController().signal,
    );

    expect(list).toStrictEqual({ models: [], defaultModel: null });
  });

  it("has the Fast extension ask Codex's model list, which decides Fast", async () => {
    const { dir, piPath } = await setUp();
    const list = await startModelListServer();
    cleanups.push(() => list.close());
    const faux = await fauxPi(
      { provider: "openai-codex", replies: [], models: [{ id: "gpt-6-sol" }, { id: "gpt-5.5" }, { id: "gpt-6" }] },
      dir,
    );

    const { models } = await queryModels(
      { piPath, args: faux.args, cwd: dir, env: { ...faux.env, [FAUX_BASE_URL_ENV]: list.baseUrl } },
      isolatedDeps(dir),
      new AbortController().signal,
      { fastExtension: FAST_EXTENSION },
    );

    expect(Object.fromEntries(models.map((model) => [model.modelId, model.fast]))).toStrictEqual({
      [FAUX_MODEL]: null,
      "gpt-6-sol": { speed: 1.5, moreUsage: false },
      "gpt-5.5": null,
      // Not in the list, so no Fast, though the built-in rule would give it.
      "gpt-6": null,
    });
    expect(list.requests).toHaveLength(1);
  });
});
