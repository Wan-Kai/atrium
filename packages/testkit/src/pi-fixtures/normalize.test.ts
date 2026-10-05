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
