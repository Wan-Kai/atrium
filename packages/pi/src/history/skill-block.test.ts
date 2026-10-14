import { describe, expect, it } from "vitest";
import { readSkillBlock } from "./skill-block";

/** A message as pi keeps it after `/skill:review` and `after`. */
function block(after: string | null): string {
  const message =
    '<skill name="review" location="/skills/review/SKILL.md">\nReferences are relative to /skills/review.\n\nRead the diff.\n</skill>';
  return after === null ? message : `${message}\n\n${after}`;
}

describe("readSkillBlock", () => {
  it("reads the skill's name and what followed it, trimmed as pi trims it", () => {
    expect(readSkillBlock(block("  look at the tests\nand the docs \n"))).toStrictEqual({
      name: "review",
      args: "look at the tests\nand the docs",
    });
    expect(readSkillBlock(block(null))).toStrictEqual({ name: "review", args: "" });
    expect(readSkillBlock(block("   "))).toStrictEqual({ name: "review", args: "" });
  });

  it("leaves alone a message that only looks like one", () => {
    expect(readSkillBlock("hello")).toBeNull();
    expect(readSkillBlock(`say ${block("x")}`)).toBeNull();
    expect(readSkillBlock(block("x").replace("</skill>", "</skil>"))).toBeNull();
    expect(readSkillBlock('<skill name="" location="/x">\nbody\n</skill>')).toBeNull();
    expect(readSkillBlock('<skill name="a" location="/x">\nbody\n</skill>\nno blank line')).toBeNull();
  });
});
