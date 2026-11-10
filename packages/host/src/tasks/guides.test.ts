import { GUIDE_IDS } from "@atrium/pi";
import { describe, expect, it } from "vitest";
import { GUIDES, UNCHOSEN_GUIDE, guideRecord } from "./guides";

/** The text of a guide. */
function textOf(id: string): string | undefined {
  return GUIDES.find((guide) => guide.id === id)?.text;
}

describe('the four guides (SPEC-0006, "附录：引导词")', () => {
  it("are the four ids the task conversation's tool names, in order, each with a version", () => {
    expect(GUIDES.map((guide) => guide.id)).toStrictEqual([...GUIDE_IDS]);
    expect(GUIDES.map((guide) => guide.version)).toStrictEqual([1, 1, 1, 1]);
  });

  it("each begin by naming themselves, so the agent can say which it chose", () => {
    for (const guide of GUIDES) expect(guide.text).toContain(`【引导词 ${guide.id} ·`);
  });

  it("keep the implementing node apart from the one that verifies it, in every guide that writes code", () => {
    for (const id of ["feature", "fix", "scheduled_fix"] as const) {
      expect(textOf(id)).toContain("work");
      expect(textOf(id)).toMatch(/check，place=workspace/u);
      expect(textOf(id)).toContain("单独的节点");
    }
  });

  it("end a code-writing graph at a human node that merges, and give the research guide no work node", () => {
    for (const id of ["feature", "fix", "scheduled_fix"] as const) {
      expect(textOf(id)).toContain("human，merge=true");
    }
    expect(textOf("research")).not.toContain("merge=true");
    expect(textOf("research")).toContain("不要 work 节点和 check 节点");
  });

  it("record the id and version a task keeps, and refuse a guide that does not exist", () => {
    expect(guideRecord("fix")).toStrictEqual({ id: "fix", version: 1 });
    expect(UNCHOSEN_GUIDE).toStrictEqual({ id: "default", version: 1 });
    expect(() => guideRecord("party" as never)).toThrow("no guide party");
  });
});
