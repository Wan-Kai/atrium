import type { DirEntry, StudyProgress } from "@atrium/protocol";
import { describe, expect, it } from "vitest";
import {
  archiveFiles,
  demoGroups,
  directionHomeDir,
  directionPath,
  inDirectionVisuals,
  isDirectionVisual,
} from "./archive";

/** Two levels before the current third: the first skipped, the second with three lessons and a sheet. */
const PROGRESS: StudyProgress = {
  profile: {},
  ladder: [
    { id: "l1", name: "语法", topics: "", pass: "", state: "skipped" },
    { id: "l2", name: "所有权", topics: "", pass: "", state: "done" },
    { id: "l3", name: "trait", topics: "", pass: "", state: "current" },
  ],
  steps: {
    l2: [
      { id: "a", kind: "lesson", title: "移动", lesson: null, quiz: null, done: null },
      { id: "b", kind: "lesson", title: "借用", lesson: null, quiz: null, done: null },
      { id: "c", kind: "lesson", title: "可变借用的流向", lesson: null, quiz: null, done: null },
      { id: "d", kind: "sheet", done: null },
    ],
    l3: [{ id: "a", kind: "lesson", title: "trait 对象", lesson: null, quiz: null, done: null }],
  },
  gaps: [],
  finishedAt: null,
};

describe("the archive's demos (SPEC-0008, ML4)", () => {
  it("groups the visuals by level, the newest level first, each by step then name, naming its lesson", () => {
    const groups = demoGroups(
      ["2-03-borrow-flow.html", "2-01-move.html", "3-01-dyn.html", "2-01-again.html", "2-04-sheet.html"],
      PROGRESS,
    );

    expect(groups).toStrictEqual([
      { level: 3, demos: [{ name: "3-01-dyn.html", label: "第 1 步 · trait 对象" }] },
      {
        level: 2,
        demos: [
          { name: "2-01-again.html", label: "第 1 步 · 移动" },
          { name: "2-01-move.html", label: "第 1 步 · 移动" },
          { name: "2-03-borrow-flow.html", label: "第 3 步 · 可变借用的流向" },
          { name: "2-04-sheet.html", label: "第 4 步 · 速查表" },
        ],
      },
    ]);
  });

  it("puts last, by name alone, a visual not named by the rule or of a level or step not there", () => {
    const groups = demoGroups(
      [
        "stack-vs-heap.html",
        "1-01-skipped.html",
        "2-09-gone.html",
        "9-01-far.html",
        "2-1-short.html",
        "2-03-.html",
        "a.html",
      ],
      PROGRESS,
    );

    expect(groups).toStrictEqual([
      {
        level: null,
        demos: [
          { name: "1-01-skipped.html", label: null },
          { name: "2-03-.html", label: null },
          { name: "2-09-gone.html", label: null },
          { name: "2-1-short.html", label: null },
          { name: "9-01-far.html", label: null },
          { name: "a.html", label: null },
          { name: "stack-vs-heap.html", label: null },
        ],
      },
    ]);
  });

  it("matches nothing without progress, and lists only .html files", () => {
    expect(demoGroups(["2-01-move.html", "notes.txt", "2-01-x.HTML"], null)).toStrictEqual([
      {
        level: null,
        demos: [
          { name: "2-01-move.html", label: null },
          { name: "2-01-x.HTML", label: null },
        ],
      },
    ]);
    expect(demoGroups([], PROGRESS)).toStrictEqual([]);
  });
});

describe("the archive's files (SPEC-0008, ML4)", () => {
  it("lists the known ones in their order, the learner's own between lab/ and AGENTS.md by name, and no visuals/", () => {
    const entries: DirEntry[] = [
      { name: "AGENTS.md", kind: "file" },
      { name: "zeta.txt", kind: "file" },
      { name: "visuals", kind: "dir" },
      { name: "lab", kind: "dir" },
      { name: "cheatsheet.md", kind: "file" },
      { name: "drafts", kind: "dir" },
      { name: "notes", kind: "dir" },
      { name: "resources.md", kind: "file" },
      { name: "link", kind: "link" },
    ];

    expect(archiveFiles(entries).map(({ name }) => name)).toStrictEqual([
      "resources.md",
      "cheatsheet.md",
      "notes",
      "lab",
      "drafts",
      "link",
      "zeta.txt",
      "AGENTS.md",
    ]);
    expect(archiveFiles([{ name: "AGENTS.md", kind: "file" }])).toStrictEqual([{ name: "AGENTS.md", kind: "file" }]);
  });

  it("knows a known name only of its kind: a folder named resources.md is the learner's own", () => {
    expect(
      archiveFiles([
        { name: "resources.md", kind: "dir" },
        { name: "notes", kind: "file" },
        { name: "AGENTS.md", kind: "file" },
      ]).map(({ name }) => name),
    ).toStrictEqual(["notes", "resources.md", "AGENTS.md"]);
  });
});

describe("a direction's paths (SPEC-0008, ML4)", () => {
  it("knows a visual right in visuals/, which the viewer tab shows rendered", () => {
    expect(
      [
        "visuals/2-03-a.html",
        "visuals/a.HTM",
        "visuals/sub/a.html",
        "visuals/a.txt",
        "lab/visuals/a.html",
        "visuals/",
        "a.html",
      ].map(isDirectionVisual),
    ).toStrictEqual([true, false, false, false, false, false, false]);
  });

  it("knows a demo named in any case, as the Mac's volume does", () => {
    expect(
      ["Visuals/a.html", "VISUALS/a.HTML", "visuals/a.Html", "Visuals/sub/a.html", "lab/Visuals/a.html"].map(
        isDirectionVisual,
      ),
    ).toStrictEqual([true, true, true, false, false]);
  });

  it("knows anything in visuals/, in any case, which never goes to the browser", () => {
    expect(
      [
        "visuals/a.html",
        "Visuals/sub/a.htm",
        "VISUALS/a.txt",
        "visuals",
        "visualsx/a.html",
        "lab/visuals/a.html",
        "a.html",
      ].map(inDirectionVisuals),
    ).toStrictEqual([true, true, true, true, false, false, false]);
  });

  it("finds a direction's home, where its sessions ran, from where it is now", () => {
    expect(directionHomeDir({ dir: "/L/Archive/rust", archived: true })).toBe("/L/rust");
    expect(directionHomeDir({ dir: "/L/rust", archived: false })).toBe("/L/rust");
  });

  it("places a path a reply names in the direction: relative from it, absolute in where it is now or was", () => {
    const archived = { dir: "/L/Archive/rust", archived: true };

    expect(
      [
        "notes/2-03.md",
        "./visuals/../notes/a.md",
        "/L/Archive/rust/visuals/a.html",
        "/L/rust/visuals/a.html",
        "/L/rust-2/a.md",
        "../go/a.md",
        "/L/Archive/rust",
        "~/a.md",
      ].map((path) => directionPath(path, archived)),
    ).toStrictEqual(["notes/2-03.md", "notes/a.md", "visuals/a.html", "visuals/a.html", null, null, null, null]);
    expect(directionPath("/L/rust/notes/a.md", { dir: "/L/rust", archived: false })).toBe("notes/a.md");
  });
});
