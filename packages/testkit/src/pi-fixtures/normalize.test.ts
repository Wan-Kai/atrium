import { describe, expect, it } from "vitest";
import { createNormalizer } from "./normalize";

describe("createNormalizer", () => {
  it("fixes times: numbers under a timestamp key and ISO strings, keeping other numbers", () => {
    const normalize = createNormalizer({});

    expect(
      normalize({
        timestamp: 1791126700932,
        at: "2026-10-05T08:35:46.434Z",
        count: 3,
        created: "2026-10-05T08:35:46Z",
      }),
    ).toStrictEqual({ timestamp: 0, at: "1970-01-01T00:00:00.000Z", count: 3, created: "1970-01-01T00:00:00.000Z" });
  });

  it("fixes the time pi writes into session file names", () => {
    const normalize = createNormalizer({});

    expect(normalize("/s/2026-10-05T16-02-10-982Z_x.jsonl and 2026-10-05T16-02-14-159Z")).toBe(
      "/s/1970-01-01T00-00-00-000Z_x.jsonl and 1970-01-01T00-00-00-000Z",
    );
  });

  it("replaces paths with placeholders, the longest first, wherever they appear in a string", () => {
    const normalize = createNormalizer({ "/tmp/run": "<cwd>", "/tmp/run/pi-agent": "<agent>" });

    expect(normalize("see /tmp/run/pi-agent/auth.json and /tmp/run/a.txt")).toBe(
      "see <agent>/auth.json and <cwd>/a.txt",
    );
  });

  it("numbers UUIDs and 8-hex entry ids by first appearance and keeps every reference consistent", () => {
    const normalize = createNormalizer({ "/s": "<sessions>" });
    const session = "019a1b2c-3d4e-7f80-9a1b-2c3d4e5f6a7b";

    expect(
      normalize([
        { id: "a1b2c3d4", parentId: null, file: `/s/2026_${session}.jsonl` },
        { id: "0f0f0f0f", parentId: "a1b2c3d4", session },
        { leafId: "0f0f0f0f", since: "a1b2c3d4" },
      ]),
    ).toStrictEqual([
      { id: "e1", parentId: null, file: "<sessions>/2026_<uuid-1>.jsonl" },
      { id: "e2", parentId: "e1", session: "<uuid-1>" },
      { leafId: "e2", since: "e1" },
    ]);
  });

  it("fixes measurements: every number inside usage, token counts and wall time", () => {
    const normalize = createNormalizer({});

    expect(
      normalize({
        usage: { input: 1455, totalTokens: 2917, cost: { input: 0.5, total: 1.25 } },
        result: { tokensBefore: 2917, estimatedTokensAfter: 1468, messageCount: 4 },
        details: { wall_time_seconds: 0.4, exit_code: 3 },
        contextWindow: 128000,
      }),
    ).toStrictEqual({
      usage: { input: 0, totalTokens: 0, cost: { input: 0, total: 0 } },
      result: { tokensBefore: 0, estimatedTokensAfter: 0, messageCount: 4 },
      details: { wall_time_seconds: 0, exit_code: 3 },
      contextWindow: 128000,
    });
  });

  it("treats 8-hex text as an entry id only under the keys that hold entry ids", () => {
    const normalize = createNormalizer({});

    expect(
      normalize([
        { id: "deadbeef", targetId: "deadbeef", firstKeptEntryId: "cafef00d" },
        { text: "deadbeef", sha: "cafef00d", items: ["deadbeef"] },
      ]),
    ).toStrictEqual([
      { id: "e1", targetId: "e1", firstKeptEntryId: "e2" },
      { text: "deadbeef", sha: "cafef00d", items: ["deadbeef"] },
    ]);
  });

  it("leaves strings that only look similar, booleans and null alone", () => {
    const normalize = createNormalizer({});

    expect(
      normalize([
        "abcdefgh",
        "0123456789",
        "A1B2C3D4",
        true,
        null,
        "2026-10-05",
        "at 2026-10-05T08:35:46Z",
        "2026-10-05T08:35:46Zx",
      ]),
    ).toStrictEqual([
      "abcdefgh",
      "0123456789",
      "A1B2C3D4",
      true,
      null,
      "2026-10-05",
      "at 2026-10-05T08:35:46Z",
      "2026-10-05T08:35:46Zx",
    ]);
  });
});
