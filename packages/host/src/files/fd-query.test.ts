import { describe, expect, it } from "vitest";
import { fdArguments, parseFdOutput, rankEntries, scopeOf, scoreEntry } from "./fd-query";

describe("scoreEntry", () => {
  it("scores an exact name above a prefix, a name match above a path match, and nothing at all as 0", () => {
    expect(scoreEntry("src/session.ts", "session.ts", false)).toBe(100);
    expect(scoreEntry("src/session.ts", "SESS", false)).toBe(80);
    expect(scoreEntry("src/my-session.ts", "session", false)).toBe(50);
    expect(scoreEntry("sessions/a.ts", "session", false)).toBe(30);
    expect(scoreEntry("src/a.ts", "zzz", false)).toBe(0);
  });

  it("gives a matching directory a little more, and an empty query every entry 1", () => {
    expect(scoreEntry("src/sessions/", "sessions", true)).toBe(110);
    expect(scoreEntry("src/a/", "zzz", true)).toBe(0);
    expect(scoreEntry("src/a.ts", "", false)).toBe(1);
  });
});

describe("rankEntries", () => {
  it("puts the best matches first, then the shallower, the shorter and by name, at most 20", () => {
    const entries = [
      { path: "deep/x/session.ts", isDirectory: false },
      { path: "session.ts", isDirectory: false },
      { path: "b-session.ts", isDirectory: false },
      { path: "a-session.ts", isDirectory: false },
      { path: "sessions/", isDirectory: true },
      { path: "other.ts", isDirectory: false },
    ];

    expect(rankEntries(entries, "session").map((entry) => entry.path)).toStrictEqual([
      "sessions/",
      "session.ts",
      "deep/x/session.ts",
      "a-session.ts",
      "b-session.ts",
    ]);
    const many = Array.from({ length: 30 }, (_, index) => ({ path: `f${index}.ts`, isDirectory: false }));
    expect(rankEntries(many, "")).toHaveLength(20);
  });
});

describe("scopeOf", () => {
  it("searches inside the directory a query names, keeping it for the paths shown", () => {
    expect(scopeOf("/work/app", "src/ses", (dir) => dir === "/work/app/src")).toStrictEqual({
      baseDir: "/work/app/src",
      query: "ses",
      shownBase: "src/",
    });
    expect(scopeOf("/work/app", "src/", (dir) => dir === "/work/app/src")).toStrictEqual({
      baseDir: "/work/app/src",
      query: "",
      shownBase: "src/",
    });
  });

  it("does not scope a query without a slash, or naming no directory", () => {
    expect(scopeOf("/work/app", "session", () => true)).toBeNull();
    expect(scopeOf("/work/app", "nope/x", () => false)).toBeNull();
  });

  it("never leaves the working directory", () => {
    expect(scopeOf("/work/app", "../other/x", () => true)).toBe("outside");
    expect(scopeOf("/work/app", "/etc/x", () => true)).toBe("outside");
    expect(scopeOf("/work/app", "~/x", () => true)).toBe("outside");
    expect(scopeOf("/work/app", "src/../../x", () => true)).toBe("outside");
  });
});

describe("fdArguments", () => {
  it("asks for files and directories, hidden ones and links too, without .git, up to 100", () => {
    expect(fdArguments("/work/app", "ses", 1)).toStrictEqual([
      "--base-directory",
      "/work/app",
      "--max-results",
      "100",
      "--type",
      "f",
      "--type",
      "d",
      "--follow",
      "--hidden",
      "--exclude",
      ".git",
      "--exclude",
      ".git/*",
      "--exclude",
      ".git/**",
      "--max-depth",
      "1",
      "--fixed-strings",
      "ses",
    ]);
  });

  it("matches a query with a slash against the whole path, and an empty query against everything", () => {
    expect(fdArguments("/w", "src/se", null).slice(-3)).toStrictEqual(["--full-path", "--fixed-strings", "src/se"]);
    expect(fdArguments("/w", "", null).at(-1)).toBe(".git/**");
  });
});

describe("parseFdOutput", () => {
  it("reads one entry a line, directories by their trailing slash, leaving .git out", () => {
    expect(parseFdOutput("src/\nsrc/a.ts\n.git/\nsub/.git/x\nREADME.md\n")).toStrictEqual([
      { path: "src/", isDirectory: true },
      { path: "src/a.ts", isDirectory: false },
      { path: "README.md", isDirectory: false },
    ]);
    expect(parseFdOutput("")).toStrictEqual([]);
  });
});
