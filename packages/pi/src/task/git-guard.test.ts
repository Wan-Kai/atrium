import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createTempDir } from "@atrium/testkit";
import { mkdir, realpath, symlink } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, expectTypeOf, it, onTestFinished } from "vitest";
import { checkGit, gitReason, guardGit, splitCommand } from "./git-guard";
import type { PathGuardApi } from "./path-guard";

/** A working directory with an outside directory, a home, and a link inside that leads outside. */
interface Tree {
  readonly cwd: string;
  readonly outside: string;
  readonly home: string;
}

/**
 * Makes a working directory with an outside directory and a home beside it, real paths all.
 *
 * @remarks
 * `link` inside the working directory points at the outside one, and `sub` is a plain directory.
 *
 * @sideEffects Creates temporary directories; deletes them when the test finishes.
 * @returns The directories.
 */
async function tree(): Promise<Tree> {
  const dir = await createTempDir("git-guard");
  onTestFinished(dir.cleanup);
  const root = await realpath(dir.path);
  const made = { cwd: join(root, "work"), outside: join(root, "outside"), home: join(root, "home") };
  for (const path of Object.values(made)) await mkdir(path, { recursive: true });
  await mkdir(join(made.cwd, "sub", "deep"), { recursive: true });
  await symlink(made.outside, join(made.cwd, "link"), "dir");
  return made;
}

/**
 * Whether a command is allowed in a tree.
 *
 * @sideEffects Reads the file system.
 * @param t - The tree.
 * @param command - The command, where `OUT` stands for the outside directory.
 * @returns Whether the guard lets it run.
 */
function allowed(t: Tree, command: string): boolean {
  return checkGit(command.replaceAll("OUT", t.outside), t.cwd, t.home).allowed;
}

/**
 * The words of each simple command, as text.
 *
 * @sideEffects none
 * @param command - The command.
 * @returns The words.
 */
function texts(command: string): string[][] {
  return splitCommand(command).map((words) => words.map((word) => word.text));
}

describe("splitCommand", () => {
  it("splits on the shell's separators and drops empty commands", () => {
    expect(texts("a b; c && d || e | f & g\nh (i)")).toStrictEqual([
      ["a", "b"],
      ["c"],
      ["d"],
      ["e"],
      ["f"],
      ["g"],
      ["h"],
      ["i"],
    ]);
  });

  it("reads single quotes, double quotes and backslashes as the shell does", () => {
    expect(texts(`git -C 'a b' "c d" e\\ f "g\\"h" 'i\\j' ""`)).toStrictEqual([
      ["git", "-C", "a b", "c d", "e f", 'g"h', "i\\j", ""],
    ]);
  });

  it("joins a quoted piece to the word it touches", () => {
    expect(texts(`--git-dir="/a b"/c`)).toStrictEqual([["--git-dir=/a b/c"]]);
  });

  it("skips comments, and a line continuation joins the lines", () => {
    expect(texts("a # b c\nd \\\ne")).toStrictEqual([["a"], ["d", "e"]]);
    expect(texts("a#b")).toStrictEqual([["a#b"]]);
  });

  it("marks expansions it cannot know, and keeps $HOME, ~ and $PWD as placeholders", () => {
    const words = splitCommand("x $A ${B} $(c) `d` ~u ~ ~/e $HOME $PWD $(pwd) `pwd` '$A' \"$A\" a~ $ $((1))")
      .flat()
      .slice(-17);
    expect(words.map((word) => word.unknown)).toStrictEqual([
      false, // x
      true, // $A
      true, // ${B}
      true, // $(c)
      true, // `d`
      true, // ~u
      false, // ~
      false, // ~/e
      false, // $HOME
      false, // $PWD
      false, // $(pwd)
      false, // `pwd`
      false, // '$A'
      true, // "$A"
      false, // a~
      false, // $
      true, // $((1))
    ]);
    expect(words[6]?.text).toBe("\u0002");
    expect(words[7]?.text).toBe("\u0002/e");
    expect(words[9]?.text).toBe("\u0001");
    expect(words[12]?.text).toBe("$A");
  });

  it("reads the commands inside $( ) and backquotes as commands of their own, ahead of the one that holds them", () => {
    expect(texts('echo $(git -C /x log) `git status` "$(a (b))" z')).toStrictEqual([
      ["git", "-C", "/x", "log"],
      ["git", "status"],
      ["a"],
      ["b"],
      ["echo", "", "", "", "z"],
    ]);
  });

  it("keeps an unterminated quote or substitution to the end", () => {
    expect(texts("a 'b c")).toStrictEqual([["a", "b c"]]);
    expect(texts('a "b c')).toStrictEqual([["a", "b c"]]);
    expect(texts("a `b c")).toStrictEqual([
      ["b", "c"],
      ["a", ""],
    ]);
  });
});

describe("checkGit: git pointed outside the working directory (SPEC-0006, 路径隔离 · bash)", () => {
  it("lets git that stays inside go, in every spelling of the options", async () => {
    const t = await tree();
    for (const command of [
      "git status",
      "git commit -m 'x' && git log --oneline | head",
      "git -C . status",
      "git -C sub status",
      "git -C sub -C deep status",
      "git -C sub -C .. status",
      "git -C ./sub/../sub/deep log",
      `git -C ${t.cwd}/sub log`,
      "git -C '' status",
      "git --git-dir=.git status",
      "git --git-dir .git --work-tree . status",
      "git --work-tree=sub status",
      "GIT_DIR=.git git status",
      "GIT_WORK_TREE=. git status",
      "GIT_DIR='sub/.git' git status",
      "export GIT_DIR=.git; git status",
      "env GIT_DIR=.git git status",
      `git -C "$PWD" status`,
      `git -C "$(pwd)" status`,
      "git -C `pwd` status",
      "git -c user.name=x -c user.email=y -C sub commit -m z",
      "git --no-pager -C sub log",
      "git commit -C HEAD",
      "git log -C /anywhere/after/the/subcommand",
      "git grep -C 3 x",
      "cd sub && git status",
      "cd sub; cd deep; git -C .. status",
      "cd sub && cd .. && git status",
      "cd . && git status",
      "echo hello > ../x.txt",
      "ls OUT",
      "cd OUT && ls",
      "grep -r git OUT",
      "tar -C OUT -xf a.tar",
      "make -C OUT",
    ]) {
      expect([command, allowed(t, command)]).toStrictEqual([command, true]);
    }
  });

  it("takes ~ and $HOME as the home directory it was given", async () => {
    const t = await tree();
    const home = join(t.cwd, "sub");

    for (const command of [
      "git -C ~ status",
      "git -C ~/deep status",
      "git -C $HOME status",
      "git -C ${HOME}/deep status",
      "GIT_DIR=~/deep git status",
      "cd ~ && git status",
      "git -C ~/.. status",
    ]) {
      expect([command, checkGit(command, t.cwd, home).allowed]).toStrictEqual([command, true]);
    }
    expect(checkGit("git -C ~/../.. status", t.cwd, home).allowed).toBe(false);
  });

  it("blocks -C to a place outside, absolute, relative, through ~ and through a link", async () => {
    const t = await tree();
    for (const command of [
      "git -C OUT commit -m x",
      "git -C ../outside commit -m x",
      "git -C .. status",
      "git -C / status",
      "git -C ~ status",
      "git -C ~/x status",
      "git -C $HOME status",
      "git -C ${HOME}/x status",
      "git -C link status",
      "git -C link/x status",
      "git -C sub -C ../.. status",
      "git -C sub -C ../../outside status",
      "git -C 'OUT' status",
      'git -C "OUT" status',
      "git -C OUT\\ x status",
      "git -c user.name=x -C OUT commit",
      "git --no-pager -C OUT log",
      "/usr/bin/git -C OUT log",
      "env git -C OUT log",
      "time git -C OUT log",
      "true && git -C OUT log",
      "echo $(git -C OUT log)",
      "echo `git -C OUT log`",
      'echo "$(git -C OUT log)"',
      "(git -C OUT log)",
      "git status | git -C OUT log",
    ]) {
      expect([command, allowed(t, command)]).toStrictEqual([command, false]);
    }
  });

  it("blocks --git-dir and --work-tree outside, in the = form and the space form", async () => {
    const t = await tree();
    for (const command of [
      "git --git-dir=OUT/.git status",
      "git --git-dir OUT/.git status",
      "git --git-dir=../outside/.git status",
      "git --work-tree=OUT status",
      "git --work-tree OUT status",
      'git --git-dir="OUT/.git" status',
      "git --git-dir=.git --work-tree=OUT status",
      "git --work-tree=. --git-dir OUT/.git status",
      "git --git-dir=link/.git status",
      "git -C sub --git-dir=../../outside/.git status",
    ]) {
      expect([command, allowed(t, command)]).toStrictEqual([command, false]);
    }
  });

  it("blocks GIT_DIR= and GIT_WORK_TREE= outside, however they are set", async () => {
    const t = await tree();
    for (const command of [
      "GIT_DIR=OUT/.git git status",
      "GIT_WORK_TREE=OUT git status",
      "GIT_DIR=OUT/.git GIT_WORK_TREE=OUT git commit -m x",
      "export GIT_DIR=OUT/.git; git status",
      "export GIT_WORK_TREE=OUT && git status",
      "env GIT_DIR=OUT/.git git status",
      "GIT_DIR='OUT/.git' git status",
      'GIT_DIR="OUT/.git" git status',
      "GIT_DIR=../outside/.git git status",
      "GIT_DIR=~/x git status",
      "GIT_WORK_TREE=link git status",
      "GIT_DIR=OUT/.git",
    ]) {
      expect([command, allowed(t, command)]).toStrictEqual([command, false]);
    }
  });

  it("blocks git run after cd to a place outside, and follows relative cd and the directories after it", async () => {
    const t = await tree();
    for (const command of [
      "cd OUT && git commit -m x",
      "cd OUT; git status",
      "cd .. && git status",
      "cd ../outside && git status",
      "cd && git status",
      "cd ~ && git status",
      "cd - && git status",
      "cd link && git status",
      "pushd OUT && git status",
      "cd sub && popd && git status",
      "cd -P OUT && git status",
      "cd -- OUT && git status",
      "cd sub && cd ../.. && git status",
      "cd OUT && cd ../work && git -C ../outside status",
      "cd OUT && true || git status",
      "cd OUT\ngit status",
      "(cd OUT && git status)",
    ]) {
      expect([command, allowed(t, command)]).toStrictEqual([command, false]);
    }
  });

  it("resolves a relative -C or cd from where the shell is, not from the starting directory", async () => {
    const t = await tree();
    expect(allowed(t, "cd sub && git -C ../.. status")).toBe(false);
    expect(allowed(t, "cd sub && git -C ../sub/deep status")).toBe(true);
    expect(allowed(t, "cd OUT && cd ../work/sub && git status")).toBe(true);
    expect(allowed(t, "cd sub/deep && git -C ../../.. log")).toBe(false);
    expect(allowed(t, 'cd sub && git -C "$PWD/deep" log')).toBe(true);
    expect(allowed(t, 'cd sub && git -C "$PWD/../.." log')).toBe(false);
  });

  it("refuses a path or a directory it cannot work out, and git itself when the directory is unknown", async () => {
    const t = await tree();
    for (const command of [
      'git -C "$X" status',
      "git -C $(dirname $0) status",
      "git -C `dirname $0` status",
      "D=OUT; git -C $D status",
      "GIT_DIR=$X git status",
      "GIT_DIR=$X/.git git status",
      "git --git-dir=$X status",
      "git $OPTS status",
      "git ${OPTS} status",
      "git -C ~nobody status",
      "cd $X && git status",
      'cd "$(mktemp -d)" && git init',
      "cd ~nobody && git status",
    ]) {
      expect([command, allowed(t, command)]).toStrictEqual([command, false]);
    }
    expect(allowed(t, "cd $X && ls")).toBe(true);
    expect(allowed(t, "cd $X && cd /nonexistent-atrium-dir && ls")).toBe(true);
  });

  it("reads scripts handed to a shell or eval", async () => {
    const t = await tree();
    for (const command of [
      `bash -c 'git -C OUT status'`,
      `sh -c "git -C OUT status"`,
      `zsh -lc 'git --git-dir=OUT/.git log'`,
      `bash -c 'cd OUT && git status'`,
      `bash -c 'bash -c "git -C OUT status"'`,
      `bash -c 'GIT_DIR=OUT git status'`,
      `eval "git -C OUT status"`,
      `eval git -C OUT status`,
      `bash -c "$CMD"`,
      `cd sub && bash -c 'git -C ../.. status'`,
    ]) {
      expect([command, allowed(t, command)]).toStrictEqual([command, false]);
    }
    for (const command of [
      `bash -c 'git -C sub status'`,
      `bash -c 'git status'`,
      `bash script.sh`,
      `bash`,
      `sh -x script.sh`,
      `eval`,
      `cd sub && bash -c 'git -C deep status'`,
      `cd sub && bash -c 'git -C "$PWD" status'`,
    ]) {
      expect([command, allowed(t, command)]).toStrictEqual([command, true]);
    }
  });

  it("gives up on scripts nested too deep", async () => {
    const t = await tree();
    let command = "git status";
    for (let depth = 0; depth < 6; depth++) command = `bash -c '${command.replaceAll("'", `'\\''`)}'`;

    expect(allowed(t, command)).toBe(false);
    expect(allowed(t, "bash -c 'bash -c \"git status\"'")).toBe(true);
  });

  it("blocks everything when the working directory's real path cannot be worked out", () => {
    expect(checkGit("git status", "/nonexistent-atrium-root/\0x", "/h").allowed).toBe(false);
  });

  it("gives the same reason for every refusal, naming the working directory", async () => {
    const t = await tree();

    expect(checkGit(`git -C ${t.outside} log`, t.cwd, t.home)).toStrictEqual({
      allowed: false,
      reason: gitReason(t.cwd),
    });
    expect(gitReason("/w")).toContain("inside /w");
    expect(gitReason("/w")).toContain("GIT_WORK_TREE");
  });
});

describe("guardGit", () => {
  /** What the hook gets and gives. */
  type Handler = (
    event: { readonly toolName: string; readonly input: unknown },
    ctx: { readonly cwd: string },
  ) => { block: true; reason: string } | undefined;

  /**
   * Registers the guard on a stand-in and returns the hook it registered.
   *
   * @sideEffects none
   * @param on - Whether the session is isolated.
   * @returns The hook.
   */
  function hook(on: boolean): Handler {
    const handlers: Handler[] = [];
    guardGit({ on: (_event, handler) => handlers.push(handler) }, () => on);
    const [only] = handlers;
    if (only === undefined || handlers.length !== 1) throw new Error("expected one hook");
    return only;
  }

  it("fits pi's extension API", () => {
    expectTypeOf<ExtensionAPI>().toExtend<PathGuardApi>();
    expect(true).toBe(true);
  });

  it("blocks a bash command that points git outside, with the reason, and lets a plain one go", async () => {
    const t = await tree();
    const check = hook(true);

    expect(check({ toolName: "bash", input: { command: `git -C ${t.outside} commit` } }, { cwd: t.cwd })).toStrictEqual(
      {
        block: true,
        reason: gitReason(t.cwd),
      },
    );
    expect(check({ toolName: "bash", input: { command: "git status" } }, { cwd: t.cwd })).toBeUndefined();
  });

  it("leaves other tools, and calls without a text command, to pi", async () => {
    const t = await tree();
    const check = hook(true);

    expect(check({ toolName: "read", input: { command: `git -C ${t.outside} x` } }, { cwd: t.cwd })).toBeUndefined();
    expect(check({ toolName: "bash", input: { command: 3 } }, { cwd: t.cwd })).toBeUndefined();
    expect(check({ toolName: "bash", input: null }, { cwd: t.cwd })).toBeUndefined();
    expect(check({ toolName: "bash", input: "git -C / x" }, { cwd: t.cwd })).toBeUndefined();
  });

  it("lets everything through when the session is not isolated", async () => {
    const t = await tree();

    expect(
      hook(false)({ toolName: "bash", input: { command: `git -C ${t.outside} commit` } }, { cwd: t.cwd }),
    ).toBeUndefined();
  });
});
