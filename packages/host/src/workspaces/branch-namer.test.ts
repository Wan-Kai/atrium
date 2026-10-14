import { CommandError, type ModelRef } from "@atrium/protocol";
import { GIT_SCENE_ENV, type GitScene, createGitScene, createTempDir } from "@atrium/testkit";
import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { recordingTracing } from "../../test/recording-tracing";
import { systemClock } from "../platform/clock";
import { type GitRunner, createGitRunner } from "../platform/git";
import { ResourceTracker } from "../platform/resources";
import { createProjectService } from "../projects/project-service";
import { PROJECTS_FILE } from "../store/index-schema";
import { loadIndexFile } from "../store/index-file";
import { BRANCH_INSTRUCTIONS, type BranchNameRequest, cleanBranchName, createBranchNamer } from "./branch-namer";

// Each test builds real repositories and runs git; next to the other test files running at once,
// that takes well over the default 5 seconds.
vi.setConfig({ testTimeout: 30_000 });

const TITLE: ModelRef = { providerId: "faux", modelId: "title" };
const PAGE: ModelRef = { providerId: "faux", modelId: "page" };
const DEFAULT: ModelRef = { providerId: "faux", modelId: "default" };

/**
 * A repository with a remote, at its real path.
 *
 * @remarks
 * Projects keep real paths; the system's temporary folder is reached through a link on macOS.
 *
 * @sideEffects Creates the repositories, removed when the test ends.
 * @returns The scene with real paths.
 */
async function scene(): Promise<GitScene> {
  const built = await createGitScene("name");
  onTestFinished(built.cleanup);
  const root = await realpath(built.root);
  return { ...built, root, repo: join(root, "repo"), origin: join(root, "origin.git") };
}

/**
 * A namer over a project registered at the scene's repository, after a plain folder's project.
 *
 * @remarks
 * git and the index are real; the one-shot call is a stand-in answering `answer`, or failing when
 * it is an error, and noting what it was asked.
 *
 * @sideEffects Creates the index directory and the plain folder.
 * @param repo - The scene.
 * @param setup - The answer, the models, and git (`null` for none).
 * @returns The namer, the services, the projects' ids, the calls made and logs.
 */
async function namer(
  repo: GitScene,
  setup: {
    readonly answer?: string | Error;
    readonly titleModel?: () => Promise<ModelRef | null>;
    readonly defaultModel?: () => Promise<ModelRef | null>;
    readonly git?: GitRunner | null;
  } = {},
) {
  const index = await createTempDir("index");
  onTestFinished(index.cleanup);
  const { file } = await loadIndexFile(index.path, PROJECTS_FILE, 0);
  let next = 0;
  const git =
    setup.git === undefined
      ? createGitRunner({ env: GIT_SCENE_ENV, clock: systemClock, resources: new ResourceTracker() })
      : setup.git;
  const projects = createProjectService({
    file,
    git: Promise.resolve(git),
    newId: (prefix) => `${prefix}_${String((next += 1)).padStart(16, "0")}`,
  });
  const plain = join(repo.root, "plain");
  await mkdir(plain, { recursive: true });
  const plainId = await projects.add(plain);
  const projectId = await projects.add(repo.repo);
  const asked: { request: BranchNameRequest; listedIn: string[] }[] = [];
  const listedIn: string[] = [];
  const { logger, records } = recordingTracing();
  const named = createBranchNamer({
    projects,
    git: Promise.resolve(git),
    titleModel: async (dir) => {
      listedIn.push(dir);
      return (setup.titleModel ?? (async () => null))();
    },
    models: async (dir) => {
      listedIn.push(dir);
      return { defaultModel: await (setup.defaultModel ?? (async () => DEFAULT))() };
    },
    oneShot: async (request) => {
      asked.push({ request, listedIn: [...listedIn] });
      const answer = setup.answer ?? "fix-login-timeout";
      if (answer instanceof Error) throw answer;
      return answer;
    },
    logger,
  });
  return { named, projects, projectId, plainId, asked, records };
}

/**
 * The error a promise rejects with.
 *
 * @sideEffects none
 * @param promise - The promise.
 * @returns Its error's code and parameters.
 */
async function failure(promise: Promise<unknown>): Promise<{ code: string; params: unknown }> {
  const error: unknown = await promise.then(
    () => null,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(CommandError);
  const { code, params } = error as CommandError;
  return { code, params };
}

/**
 * Takes the models asked, in order, from the namer's calls.
 *
 * @sideEffects none
 * @param asked - The calls.
 * @returns Each call's model.
 */
const modelsOf = (asked: readonly { request: BranchNameRequest }[]): ModelRef[] =>
  asked.map(({ request }) => request.model);

describe("cleanBranchName", () => {
  it("keeps the first line in lower case, with one `-` for each run of anything else, and nothing before a `/`", () => {
    expect(
      [
        "fix-login-timeout",
        "  Fix Login Timeout.\nThat is the name.",
        "atrium/feature/add-dark-mode",
        "`Fix_the  bug`",
        "--add 2 tests--",
        "\n\nfix-it\n",
      ].map(cleanBranchName),
    ).toStrictEqual([
      "fix-login-timeout",
      "fix-login-timeout",
      "add-dark-mode",
      "fix-the-bug",
      "add-2-tests",
      "fix-it",
    ]);
  });

  it("cuts a name over 40 characters at its last `-` within them, or at 40 without one", () => {
    const forty = `${"a".repeat(19)}-${"b".repeat(20)}`;
    expect(
      [`${forty}-more`, `${forty}more-yes`, "c".repeat(45), `${"d".repeat(10)}-${"e".repeat(40)}`].map(cleanBranchName),
    ).toStrictEqual([forty, "a".repeat(19), "c".repeat(40), "d".repeat(10)]);
  });

  it("gives no name when fewer than 2 characters are left", () => {
    expect(["", "a", "修复登录", "-x-", "ab"].map(cleanBranchName)).toStrictEqual([null, null, null, null, "ab"]);
  });
});

describe("createBranchNamer", () => {
  it("asks the model in the project's directory, with the instructions, the message cut to 1200 characters and 15 seconds", async () => {
    const repo = await scene();
    const { named, projectId, asked } = await namer(repo);
    // Emoji count as one character each, so none is cut in half.
    const text = `${"😀".repeat(1199)}🐙🦑`;

    expect(await named.name(projectId, text, PAGE)).toBe("atrium/fix-login-timeout");
    expect(asked).toStrictEqual([
      {
        request: {
          cwd: repo.repo,
          model: PAGE,
          systemPrompt: BRANCH_INSTRUCTIONS,
          input: `${"😀".repeat(1199)}🐙`,
          timeoutMs: 15_000,
        },
        listedIn: [repo.repo],
      },
    ]);
  });

  it("takes the title model pi lists, else the page's model, else pi's default in the project's directory", async () => {
    const repo = await scene();
    const chosen = await namer(repo, { titleModel: async () => TITLE });
    const unlisted = await namer(repo);
    const unknown = await namer(repo, { titleModel: () => Promise.reject(new Error("pi failed")) });
    const fallback = await namer(repo);

    await chosen.named.name(chosen.projectId, "Fix it", PAGE);
    await unlisted.named.name(unlisted.projectId, "Fix it", PAGE);
    await unknown.named.name(unknown.projectId, "Fix it", PAGE);
    await fallback.named.name(fallback.projectId, "Fix it", null);

    expect([chosen, unlisted, unknown].map(({ asked }) => modelsOf(asked))).toStrictEqual([[TITLE], [PAGE], [PAGE]]);
    expect(fallback.asked).toMatchObject([{ request: { model: DEFAULT }, listedIn: [repo.repo, repo.repo] }]);
  });

  it("fails with no model when there is none to ask, logging only the project and why", async () => {
    const repo = await scene();
    const none = await namer(repo, { defaultModel: async () => null });
    const unlisted = await namer(repo, { defaultModel: () => Promise.reject(new Error("pi failed")) });

    expect(await failure(none.named.name(none.projectId, "Fix it", null))).toStrictEqual({
      code: "branch_name_failed",
      params: { reason: "no_model" },
    });
    expect(await failure(unlisted.named.name(unlisted.projectId, "Fix it", null))).toStrictEqual({
      code: "branch_name_failed",
      params: { reason: "no_model" },
    });
    expect([none.asked, unlisted.asked]).toStrictEqual([[], []]);
    expect(none.records.filter((record) => record["msg"] === "branch not named")).toStrictEqual([
      expect.objectContaining({ projectId: none.projectId, reason: "no_model" }),
    ]);
  });

  it("fails when the call fails or its answer is no name, logging neither the message nor the answer", async () => {
    const repo = await scene();
    const failed = await namer(repo, { answer: new Error("model said: secret plan") });
    const invalid = await namer(repo, { answer: "名字" });

    expect(await failure(failed.named.name(failed.projectId, "secret plan", PAGE))).toStrictEqual({
      code: "branch_name_failed",
      params: { reason: "failed" },
    });
    expect(await failure(invalid.named.name(invalid.projectId, "secret plan", PAGE))).toStrictEqual({
      code: "branch_name_failed",
      params: { reason: "invalid" },
    });
    const logged = [...failed.records, ...invalid.records].filter((record) => record["msg"] === "branch not named");
    expect(logged.map(({ projectId, reason }) => ({ projectId, reason }))).toStrictEqual([
      { projectId: failed.projectId, reason: "failed" },
      { projectId: invalid.projectId, reason: "invalid" },
    ]);
    expect(JSON.stringify([...failed.records, ...invalid.records])).not.toMatch(/secret|名字/);
  });

  it("adds `-2` up to `-9` while a local branch, a folder or a workspace's record has the name", async () => {
    const repo = await scene();
    const { named, projects, projectId } = await namer(repo);
    const worktrees = join(repo.root, "repo.worktrees");
    await repo.git(repo.repo, "branch", "atrium/fix-login-timeout");
    await mkdir(join(worktrees, "fix-login-timeout-2"), { recursive: true });
    await projects.recordWorktrees(projectId, [join(worktrees, "fix-login-timeout-3")]);
    // Without the prefix, it is another name.
    await repo.git(repo.repo, "branch", "fix-login-timeout-4");

    expect(await named.name(projectId, "Fix it", PAGE)).toBe("atrium/fix-login-timeout-4");
  });

  it("fails when the name and all its suffixes are taken", async () => {
    const repo = await scene();
    const { named, projectId } = await namer(repo);
    await repo.git(repo.repo, "branch", "atrium/fix-login-timeout");
    for (let suffix = 2; suffix <= 9; suffix += 1) {
      await repo.git(repo.repo, "branch", `atrium/fix-login-timeout-${String(suffix)}`);
    }

    expect(await failure(named.name(projectId, "Fix it", PAGE))).toStrictEqual({
      code: "branch_name_failed",
      params: { reason: "taken" },
    });
  });

  it("names only for a known project at the top of a repository, before asking any model", async () => {
    const repo = await scene();
    const real = await namer(repo);
    const gitless = await namer(repo, { git: null });

    expect(await failure(real.named.name("prj_missing", "Fix it", PAGE))).toStrictEqual({
      code: "project_not_found",
      params: { projectId: "prj_missing" },
    });
    expect(await failure(real.named.name(real.plainId, "Fix it", PAGE))).toStrictEqual({
      code: "branch_name_failed",
      params: { reason: "not_git" },
    });
    expect(await failure(gitless.named.name(gitless.projectId, "Fix it", PAGE))).toStrictEqual({
      code: "branch_name_failed",
      params: { reason: "not_git" },
    });
    expect([real.asked, gitless.asked]).toStrictEqual([[], []]);
  });
});
