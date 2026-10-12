import { describe, expect, it } from "vitest";
import type { IndexFileSpec } from "./index-file";
import {
  CHATS_FILE,
  layoutsFile,
  PREFERENCES_FILE,
  PROJECTS_FILE,
  SESSIONS_FILE,
  turnStartsFile,
} from "./index-schema";

describe("the index's file specs", () => {
  it.each<[string, IndexFileSpec<object>]>([
    ["projects", PROJECTS_FILE],
    ["sessions", SESSIONS_FILE],
    ["chats", CHATS_FILE],
    ["layouts", layoutsFile({ sessions: [] })],
    ["preferences", PREFERENCES_FILE],
    ["turns", turnStartsFile("s1")],
  ])("start %s with a document their schema accepts, so it loads again once written", (_name, spec) => {
    const empty = spec.empty();

    expect(spec.schema.safeParse(empty)).toStrictEqual({ success: true, data: empty });
  });
});
