import { describe, expect, it } from "vitest";
import type { IndexFileSpec } from "./index-file";
import { LAYOUTS_FILE, PREFERENCES_FILE, PROJECTS_FILE, SESSIONS_FILE, turnStartsFile } from "./index-schema";

describe("the index's file specs", () => {
  it.each<[string, IndexFileSpec<object>]>([
    ["projects", PROJECTS_FILE],
    ["sessions", SESSIONS_FILE],
    ["layouts", LAYOUTS_FILE],
    ["preferences", PREFERENCES_FILE],
    ["turns", turnStartsFile("s1")],
  ])("start %s with a document their schema accepts, so it loads again once written", (_name, spec) => {
    const empty = spec.empty();

    expect(spec.schema.safeParse(empty)).toStrictEqual({ success: true, data: empty });
  });
});
