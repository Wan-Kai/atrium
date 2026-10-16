import { describe, expect, it } from "vitest";
import { sectionPieces } from "./prompt-sections";

/** A memory file's block, as pi writes it. */
const memory = (path: string, content: string) =>
  `<project_instructions path="${path}">\n${content}\n</project_instructions>`;

/** A skill's block, as pi writes it. */
const skill = (name: string, description: string) =>
  `  <skill>\n    <name>${name}</name>\n    <description>${description}</description>\n    <location>/s/${name}/SKILL.md</location>\n  </skill>`;

describe("sectionPieces", () => {
  it("splits project_context into its memory files, each its whole block, by path", () => {
    const global = memory("/home/me/.pi/agent/AGENTS.md", "Be brief.");
    const project = memory("/work/atrium/AGENTS.md", "x".repeat(50));
    const text = ["Project-specific instructions and guidelines:", global, project].join("\n\n");

    expect(sectionPieces("project_context", text)).toStrictEqual([
      { name: "/home/me/.pi/agent/AGENTS.md", chars: global.length },
      { name: "/work/atrium/AGENTS.md", chars: project.length },
    ]);
  });

  it("splits skills into its skills by name, undoing pi's XML escapes", () => {
    const tdd = skill("tdd", "Test first");
    const odd = skill("a&amp;b&lt;c&gt;&quot;d&apos;&amp;lt;", "Odd");
    const text = `The following skills…\n\n<available_skills>\n${tdd}\n${odd}\n</available_skills>`;

    expect(sectionPieces("skills", text)).toStrictEqual([
      { name: "tdd", chars: tdd.trimStart().length },
      { name: "a&b<c>\"d'&lt;", chars: odd.trimStart().length },
    ]);
  });

  it("names a skill whose name has spaces in it, and none whose block has no name", () => {
    const spaced = "<skill>\n<name>my  skill\nhere</name>\n</skill>";
    const nameless = "<skill>\n<description>x</description>\n</skill>";

    expect(sectionPieces("skills", `${spaced}\n${nameless}`)).toStrictEqual([
      { name: "my  skill\nhere", chars: spaced.length },
      { name: "", chars: nameless.length },
    ]);
  });

  it("finds no pieces in a split section without blocks, and does not split any other section", () => {
    expect(sectionPieces("project_context", "Project-specific instructions and guidelines:")).toStrictEqual([]);
    expect(sectionPieces("skills", "<available_skills>\n</available_skills>")).toStrictEqual([]);
    expect(sectionPieces("rules", memory("/a", "b"))).toBeNull();
    expect(sectionPieces("mcp_servers", skill("a", "b"))).toBeNull();
  });
});
