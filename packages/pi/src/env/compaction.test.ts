import { createTempDir } from "@atrium/testkit";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { compactionReserve } from "./compaction";

const OPUS = { providerId: "anthropic", modelId: "claude-opus-5-5" };
const SOL = { providerId: "openai-codex", modelId: "gpt-6.1-sol" };

/**
 * An agent directory for pi with the given settings file, or none.
 *
 * @sideEffects Creates the directory, removed when the test ends; writes the file.
 * @param settings - The file's text; `undefined` writes none.
 * @returns pi's environment pointing at it.
 */
async function agentDir(settings?: string): Promise<Record<string, string>> {
  const dir = await createTempDir("compaction");
  onTestFinished(dir.cleanup);
  if (settings !== undefined) await writeFile(join(dir.path, "settings.json"), settings);
  return { PI_CODING_AGENT_DIR: dir.path };
}

describe("compactionReserve", () => {
  it("is pi's default without a settings file, or with one that says nothing of compaction", async () => {
    expect(await compactionReserve(await agentDir(), OPUS)).toBe(16_384);
    expect(await compactionReserve(await agentDir('{"theme":"dark"}'), null)).toBe(16_384);
    expect(await compactionReserve(await agentDir('{"compaction":null}'), OPUS)).toBe(16_384);
  });

  it("takes the model's override, then the setting, then the default", async () => {
    const env = await agentDir(
      JSON.stringify({
        compaction: {
          reserveTokens: 30_000,
          modelOverrides: { "anthropic/claude-opus-5-5": { reserveTokens: 50_000 } },
        },
      }),
    );
    const onlyOverride = await agentDir(
      JSON.stringify({ compaction: { modelOverrides: { "openai-codex/gpt-6.1-sol": { keepRecentTokens: 1 } } } }),
    );

    expect(await Promise.all([OPUS, SOL, null].map((model) => compactionReserve(env, model)))).toStrictEqual([
      50_000, 30_000, 30_000,
    ]);
    expect(await compactionReserve(onlyOverride, SOL)).toBe(16_384);
  });

  it("is none when pi does not compact on its own", async () => {
    expect(
      await compactionReserve(await agentDir('{"compaction":{"enabled":false,"reserveTokens":9}}'), OPUS),
    ).toBeNull();
    expect(await compactionReserve(await agentDir('{"compaction":{"enabled":true,"reserveTokens":9}}'), OPUS)).toBe(9);
    expect(await compactionReserve(await agentDir('{"compaction":{"reserveTokens":0}}'), OPUS)).toBe(0);
  });

  it("is unknown when the settings are not ones pi takes", async () => {
    const settings = [
      "{ not json",
      '{"compaction":{"reserveTokens":-1}}',
      '{"compaction":{"reserveTokens":1.5}}',
      '{"compaction":{"reserveTokens":"9"}}',
      '{"compaction":{"enabled":"yes"}}',
      '{"compaction":{"modelOverrides":{"anthropic/claude-opus-5-5":{"reserveTokens":null}}}}',
    ];

    const found = await Promise.all(settings.map(async (text) => compactionReserve(await agentDir(text), OPUS)));

    expect(found).toStrictEqual([null, null, null, null, null, null]);
  });
});
