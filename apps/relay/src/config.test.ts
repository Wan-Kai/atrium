import { createTempDir } from "@atrium/testkit";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { loadConfig, relayLine } from "./config";

/**
 * A temporary data directory with `relay.json` holding `content`.
 *
 * @remarks
 * Removed after the test.
 *
 * @sideEffects Creates a directory and a file.
 * @param content - The file's text, or null for no file.
 * @returns The directory.
 */
async function dirWith(content: string | null): Promise<string> {
  const dir = await createTempDir("relay-config");
  onTestFinished(dir.cleanup);
  if (content !== null) await writeFile(join(dir.path, "relay.json"), content);
  return dir.path;
}

describe("loadConfig", () => {
  it("fills in the defaults", async () => {
    const dir = await dirWith(JSON.stringify({ publicHost: "ktoon.site" }));

    expect(await loadConfig(dir)).toStrictEqual({
      ok: true,
      config: { publicHost: "ktoon.site", pathPrefix: "", trustedProxies: [], newStreamsPerIpPerMinute: 30 },
    });
  });

  it("reads every field", async () => {
    const config = {
      publicHost: "relay.example:8443",
      pathPrefix: "/atrium/v",
      trustedProxies: ["127.0.0.1", "::1"],
      newStreamsPerIpPerMinute: 0,
    };
    const dir = await dirWith(JSON.stringify(config));

    expect(await loadConfig(dir)).toStrictEqual({ ok: true, config });
  });

  it("says when the file is missing", async () => {
    expect(await loadConfig(await dirWith(null))).toStrictEqual({ ok: false, error: { code: "config_missing" } });
  });

  it("names unknown and bad fields, without their values", async () => {
    const dir = await dirWith(
      JSON.stringify({
        publicHost: "https://x",
        pathPrefx: "/a",
        trustedProxies: ["nope"],
        newStreamsPerIpPerMinute: -1,
      }),
    );

    expect(await loadConfig(dir)).toStrictEqual({
      ok: false,
      error: {
        code: "config_invalid",
        fields: ["publicHost", "trustedProxies.0", "newStreamsPerIpPerMinute", "pathPrefx"],
      },
    });
  });

  it("names several unknown fields together", async () => {
    const dir = await dirWith(JSON.stringify({ publicHost: "ktoon.site", one: 1, two: 2 }));

    expect(await loadConfig(dir)).toStrictEqual({ ok: false, error: { code: "config_invalid", fields: ["one,two"] } });
  });

  it.each(["/atrium/", "atrium", "/a b", "//x"])("refuses the path prefix %j", async (pathPrefix) => {
    const dir = await dirWith(JSON.stringify({ publicHost: "ktoon.site", pathPrefix }));

    expect(await loadConfig(dir)).toStrictEqual({
      ok: false,
      error: { code: "config_invalid", fields: ["pathPrefix"] },
    });
  });

  it("says when the file is not JSON or not an object", async () => {
    expect(await loadConfig(await dirWith("{"))).toStrictEqual({
      ok: false,
      error: { code: "config_invalid", fields: [] },
    });
    expect(await loadConfig(await dirWith("[]"))).toStrictEqual({
      ok: false,
      error: { code: "config_invalid", fields: [""] },
    });
  });

  it("throws when the file cannot be read for another reason", async () => {
    const dir = await dirWith(null);
    await mkdir(join(dir, "relay.json"));

    await expect(loadConfig(dir)).rejects.toThrow("EISDIR");
  });
});

describe("relayLine", () => {
  it("puts the host id, token, public host and prefix in one line", () => {
    const config = {
      publicHost: "ktoon.site",
      pathPrefix: "/atrium",
      trustedProxies: [],
      newStreamsPerIpPerMinute: 30,
    };

    expect(relayLine(config, "hst_0123456789abcdef", "tok-en_")).toBe(
      "atrium-relay://hst_0123456789abcdef:tok-en_@ktoon.site/atrium",
    );
  });
});
