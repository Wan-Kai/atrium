import { createNormalizer } from "@atrium/testkit";
import { expect, it } from "vitest";
import { editCommand } from "../src/edit/edit";
import { editNormalizer } from "./edit-normalizer";

it("normalizes encoded ids with the same numbering as the surrounding tree, and preserves other commands", () => {
  const normalize = editNormalizer(createNormalizer({}));
  expect(normalize({ id: "1234abcd", leafId: "abcd1234" })).toStrictEqual({ id: "e1", leafId: "e2" });
  expect(
    normalize({ message: editCommand({ action: "rewind", token: "op", entryId: "1234abcd", leafId: "abcd1234" }) }),
  ).toStrictEqual({
    message: editCommand({ action: "rewind", token: "op", entryId: "e1", leafId: "e2" }),
  });
  expect(normalize(["/faux-navigate 1234abcd", 1, null])).toStrictEqual(["/faux-navigate e1", 1, null]);
});
