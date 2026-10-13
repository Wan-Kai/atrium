import type { MergeState, Workspace } from "@atrium/protocol";
import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type Clock, trackedTimeout } from "../platform/clock";
import { GitError, type GitRunner } from "../platform/git";
import type { Logger } from "../platform/logger";
import type { ResourceTracker } from "../platform/resources";
import type { ProjectRecord, ProjectService } from "../projects/project-service";
import type { MergeInspector } from "./merge-inspector";
import { type ListedWorktree, parseWorktreeList } from "./worktree-list";

/** How often the host fetches every project's `origin` in the background. */
export const FETCH_INTERVAL_MS = 5 * 60_000;

/** The shortest time between two fetches started by the window gaining focus. */
export const FOCUS_FETCH_GAP_MS = 60_000;

/** How long one fetch may take. */
const FETCH_TIMEOUT_MS = 120_000;

/** What a scan found about one workspace. */
interface Scanned {
  readonly branch: string | null;
  readonly head: string | null;
  readonly createdAt: number | null;
  readonly merge: MergeState | null;
}

/** Scans projects' workspaces and keeps their branches and merge states. */
export interface WorkspaceService {
  /** Every registered workspace as the list shows it, in the projects' order. */
  list(): Workspace[];
  /** The directory of a registered workspace; none for an archived one, where nothing may start. */
  dirOf(workspaceId: string): string | undefined;
  /** Scans every project, then fetches every few minutes. */
  start(): void;
  /** Scans every project, and fetches unless a fetch started within a minute. */
  windowFocused(): void;
  /** Scans the project of a workspace again, after a run in it ended. */
  refresh(workspaceId: string): void;
  /** Resolves once the scans asked for so far are done; for tests and shutdown. */
  idle(): Promise<void>;
  /** Calls `listener` after the list changed; returns a function that stops it. */
  onChange(listener: () => void): () => void;
  /** Stops scanning and fetching; resolves once git has stopped. */
  close(): Promise<void>;
}

/**
 * Creates the workspace service.
 *
 * @remarks
 * Follows SPEC-0001 ("worktree 合并状态", "项目、工作区与会话"):
 * - a project is scanned with `git worktree list --porcelain`; worktrees without a record are
 *   recorded as external, and records whose worktree is gone stay, shown as removed;
 * - an archived workspace shows what it had checked out when archived and no merge state, which
 *   scans no longer work out (SPEC-0001, "M1.11 的工作区归档");
 * - a worktree's creation time is that of its administrative directory under the repository's
 *   `worktrees/`, which outlives the worktree itself;
 * - the main branch is the project's own setting or `origin/HEAD`, nothing else
 *   (domain-model, "已决定 15");
 * - scans run when the service starts, when the window gains focus, when a run in a workspace
 *   ends, and for a project just added; files are never watched;
 * - every few minutes and on focus (at most once a minute) each project that is the top of its
 *   own repository and has an `origin` is fetched, and its merge states are worked out again
 *   without `git status`; a folder inside another repository never fetches that repository.
 *
 * Scans of one project never overlap: a scan asked for during another runs once it ends. A git
 * failure, or git failing to read a repository it read before, leaves the project's last results
 * and is logged by its reason or exit code only.
 *
 * @sideEffects none until `start`; then runs git, reads repositories' administrative files,
 * schedules timers and logs.
 * @param options - The project service, git (or `null` without it), the merge inspector, the
 * clock, the resource tracker and the logger.
 * @returns The service.
 */
export function createWorkspaceService(options: {
  readonly projects: ProjectService;
  readonly git: Promise<GitRunner | null>;
  readonly inspector: Promise<MergeInspector | null>;
  readonly clock: Clock;
  readonly resources: ResourceTracker;
  readonly logger: Logger;
}): WorkspaceService {
  const scanned = new Map<string, Scanned>();
  /** Projects last seen to be git repositories, whose results a failed read of git keeps. */
  const gitProjects = new Set<string>();
  const known = new Set<string>();
  const listeners = new Set<() => void>();
  const stop = new AbortController();
  /** Projects waiting for a scan, and whether that scan may skip `git status`. */
  const waiting = new Map<string, { readonly afterFetch: boolean }>();
  let draining: Promise<void> | null = null;
  let lastFetch = Number.NEGATIVE_INFINITY;
  let fetching: Promise<void> | null = null;
  let cancelFetchTimer: (() => void) | null = null;
  let closed = false;

  /**
   * Tells the listeners the list changed.
   *
   * @remarks
   * Listeners merge changes themselves (the index feed pushes one snapshot for many).
   *
   * @sideEffects Calls the listeners.
   */
  function changed(): void {
    for (const listener of listeners) listener();
  }

  /**
   * Asks for a scan of some projects.
   *
   * @remarks
   * A full scan replaces a pending one that would have skipped `git status`.
   *
   * @sideEffects Starts the scan loop if it is not running.
   * @param projectIds - The projects.
   * @param afterFetch - Whether only the main branch can have moved.
   */
  function request(projectIds: readonly string[], afterFetch = false): void {
    if (closed) return;
    for (const projectId of projectIds) {
      const before = waiting.get(projectId);
      waiting.set(projectId, { afterFetch: afterFetch && (before?.afterFetch ?? true) });
    }
    draining ??= drain().finally(() => {
      draining = null;
    });
  }

  /**
   * Scans waiting projects until none wait.
   *
   * @remarks
   * Projects are scanned one after another; git itself runs up to four commands at once.
   *
   * @sideEffects Runs git; updates the results; calls listeners.
   */
  async function drain(): Promise<void> {
    for (;;) {
      const next = waiting.entries().next();
      if (next.done === true || stop.signal.aborted) return;
      const [projectId, { afterFetch }] = next.value;
      waiting.delete(projectId);
      const project = options.projects.projects().find((candidate) => candidate.id === projectId);
      if (project === undefined) continue;
      try {
        await scanProject(project, afterFetch);
      } catch (error) {
        if (stop.signal.aborted) return;
        options.logger.warn({ projectId, ...failureFields(error) }, "workspace scan failed");
      }
    }
  }

  /**
   * Scans one project and keeps what it found.
   *
   * @remarks
   * See `createWorkspaceService`.
   *
   * @sideEffects Runs git; reads the repository's administrative files; may record worktrees;
   * calls listeners when the project's workspaces changed.
   * @param project - The project.
   * @param afterFetch - Whether to keep the last known `dirty` instead of running `git status`.
   */
  async function scanProject(project: ProjectRecord, afterFetch: boolean): Promise<void> {
    const before = JSON.stringify(projectWorkspaces(project.id));
    known.add(project.id);
    const git = await options.git;
    const signal = stop.signal;
    /**
     * Runs git in the project, or nothing without git.
     *
     * @remarks
     * Without git every project is a plain directory.
     *
     * @sideEffects Runs git.
     * @param args - git's arguments.
     * @returns git's result, or `null` without git.
     */
    const run = (...args: string[]) =>
      git === null ? Promise.resolve(null) : git.run(args, { cwd: project.path, signal });
    const top = await run("rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir");
    // One path a line; only the line ends go, as a path may end in a space.
    // Stryker disable next-line ArrayDeclaration: a made-up top level is not the project's path either, so nothing is listed.
    const [topLevel, common] = top?.code === 0 ? top.stdout.split("\n") : [];
    /**
     * The project's workspace records, as they are now.
     *
     * @remarks
     * Read again after recording new worktrees.
     *
     * @sideEffects none
     * @returns The records.
     */
    const records = () => options.projects.workspaces().filter((workspace) => workspace.projectId === project.id);
    const listing = topLevel === project.path ? await run("worktree", "list", "--porcelain") : null;
    // Without the common directory git did not answer, and nothing was listed either.
    if (gitProjects.has(project.id) && listing?.code !== 0) {
      // A repository git could not read just now (a drive away, a lock held): keep what was known.
      options.logger.info(
        // Stryker disable next-line OptionalChaining: `top` is only null without git, and without git no project is ever in `gitProjects`.
        { projectId: project.id, code: (listing ?? top)?.code ?? null },
        "workspace scan skipped",
      );
      return;
    }
    // Worktrees are only listed for the top of a repository, so this is "not a repository's top,
    // or one git cannot read".
    // Stryker disable next-line BlockStatement: a project in `gitProjects` has returned above, and no other project has ever had a workspace with results, so there is nothing to clear.
    if (listing?.code !== 0) {
      // Stryker disable next-line CallExpression: a project in `gitProjects` has returned above.
      gitProjects.delete(project.id);
      for (const record of records())
        // Stryker disable next-line ObjectLiteral,CallExpression: the list shows a workspace with no results, or none recorded, the same way.
        scanned.set(record.id, { branch: null, head: null, createdAt: null, merge: null });
    } else {
      gitProjects.add(project.id);
      const listed = parseWorktreeList(listing.stdout).filter((worktree) => !worktree.bare);
      // Only worktrees without a record are recorded; the project's own directory, whichever git
      // lists first, already has its record as the local workspace.
      await options.projects.recordWorktrees(
        project.id,
        listed.map((worktree) => worktree.dir),
      );
      // git prints the common directory with the top level, so it is known whenever worktrees were listed.
      // Stryker disable next-line StringLiteral: never used, as the line above says.
      const created = await creationTimes(common ?? "");
      const mainRef = await mainBranchRef(project, run);
      const inspector = await options.inspector;
      await Promise.all(
        records()
          .filter((record) => record.archived == null)
          .map(async (record) => {
            const worktree = listed.find((candidate) => candidate.dir === record.dir);
            const merge =
              record.kind === "local" || inspector === null
                ? null
                : await inspector.inspect(
                    {
                      repo: project.path,
                      dir: record.dir,
                      present: worktree !== undefined && !worktree.prunable && (await isDirectory(record.dir)),
                      branch: worktree?.branch ?? null,
                      // Stryker disable next-line StringLiteral: an unlisted worktree is not present, and the inspector calls one that is not present removed without reading its head.
                      head: worktree?.head ?? "",
                      baseCommit: record.baseCommit,
                      mainRef,
                      ...(afterFetch ? dirtyBefore(record.id) : {}),
                    },
                    signal,
                  );
            scanned.set(record.id, {
              ...branchOf(worktree),
              createdAt: record.kind === "local" ? null : (created.get(record.dir) ?? null),
              merge,
            });
          }),
      );
    }
    if (JSON.stringify(projectWorkspaces(project.id)) !== before) changed();
  }

  /**
   * The dirty state a workspace had at its last scan.
   *
   * @remarks
   * Only known when that scan worked it out.
   *
   * @sideEffects none
   * @param workspaceId - The workspace.
   * @returns `{ dirty }`, or nothing to ask for `git status`.
   */
  function dirtyBefore(workspaceId: string): { dirty?: boolean } {
    const merge = scanned.get(workspaceId)?.merge;
    return merge === null || merge === undefined || merge.verdict === "removed" ? {} : { dirty: merge.dirty };
  }

  /**
   * Fetches every project that is its own repository's top and has an `origin`, then works out
   * their merge states again.
   *
   * @remarks
   * See `createWorkspaceService`. A fetch that fails (offline, no access) is logged by its reason.
   *
   * @sideEffects Runs `git fetch`; asks for scans.
   */
  async function fetchAll(): Promise<void> {
    lastFetch = options.clock.now();
    const git = await options.git;
    if (git === null) return;
    for (const project of options.projects.projects()) {
      if (closed) return;
      /**
       * Runs git in the project.
       *
       * @remarks
       * A fetch gets a longer deadline.
       *
       * @sideEffects Runs git.
       * @param args - git's arguments.
       * @param deadline - The deadline, if not the default.
       * @returns git's result.
       */
      const run = (args: string[], deadline: { readonly timeoutMs?: number } = {}) =>
        git.run(args, { cwd: project.path, signal: stop.signal, ...deadline });
      try {
        // A folder inside another repository, or one whose repository git cannot read just now,
        // would fetch the repository around it. Only the line end goes: a name may end in a space.
        const top = await run(["rev-parse", "--path-format=absolute", "--show-toplevel"]);
        // Stryker disable next-line Regex,ConditionalExpression: git prints one line here, so its first line end is its last; when it fails it prints nothing, which is not the project's path either.
        if (top.code !== 0 || top.stdout.replace(/\n$/, "") !== project.path) continue;
        const remote = await run(["remote", "get-url", "origin"]);
        if (remote.code !== 0) continue;
        const fetched = await run(["fetch", "--quiet", "--prune", "origin"], { timeoutMs: FETCH_TIMEOUT_MS });
        if (fetched.code !== 0) {
          options.logger.info({ projectId: project.id, code: fetched.code }, "fetch failed");
          continue;
        }
        request([project.id], true);
      } catch (error) {
        if (stop.signal.aborted) return;
        options.logger.info({ projectId: project.id, ...failureFields(error) }, "fetch failed");
      }
    }
  }

  /**
   * Starts a fetch of every project unless one is running.
   *
   * @remarks
   * Kept so `close` and `idle` can wait for it.
   *
   * @sideEffects Runs git.
   */
  function startFetch(): void {
    if (closed || fetching !== null) return;
    fetching = fetchAll().finally(() => {
      fetching = null;
    });
  }

  /**
   * Schedules the next background fetch.
   *
   * @remarks
   * A chain of one-shot timers, so a fake clock drives it and closing cancels exactly one.
   *
   * @sideEffects Registers a tracked timer.
   */
  function scheduleFetch(): void {
    cancelFetchTimer = trackedTimeout(
      options.clock,
      options.resources,
      () => {
        startFetch();
        scheduleFetch();
      },
      FETCH_INTERVAL_MS,
    );
  }

  /**
   * The workspaces of one project, as the list shows them.
   *
   * @remarks
   * Before the first scan, scanned fields are empty.
   *
   * @sideEffects none
   * @param projectId - The project.
   * @returns Its workspaces.
   */
  function projectWorkspaces(projectId: string): Workspace[] {
    return options.projects
      .workspaces()
      .filter((record) => record.projectId === projectId)
      .map((record) => {
        const found = scanned.get(record.id);
        if (record.archived != null) {
          const { at, branch, head } = record.archived;
          return {
            id: record.id,
            projectId: record.projectId,
            kind: record.kind,
            dir: record.dir,
            alias: record.alias,
            branch,
            head: branch === null && head !== null ? head.slice(0, 7) : null,
            external: record.external,
            createdAt: null,
            merge: null,
            archivedAt: at,
          };
        }
        return {
          id: record.id,
          projectId: record.projectId,
          kind: record.kind,
          dir: record.dir,
          alias: record.alias,
          branch: found?.branch ?? null,
          head: found?.head ?? null,
          external: record.external,
          createdAt: found?.createdAt ?? null,
          merge: found?.merge ?? null,
          archivedAt: null,
        };
      });
  }

  options.projects.onChange(() => {
    const projects = options.projects.projects();
    const added = projects.filter((project) => !known.has(project.id)).map((project) => project.id);
    for (const id of known) if (!projects.some((project) => project.id === id)) known.delete(id);
    const records = new Set(options.projects.workspaces().map((record) => record.id));
    for (const id of scanned.keys()) if (!records.has(id)) scanned.delete(id);
    if (added.length > 0) request(added);
    changed();
  });

  return {
    list: () => options.projects.projects().flatMap((project) => projectWorkspaces(project.id)),
    dirOf(workspaceId) {
      const record = options.projects.workspaces().find((candidate) => candidate.id === workspaceId);
      return record?.archived == null ? record?.dir : undefined;
    },
    start() {
      request(options.projects.projects().map((project) => project.id));
      scheduleFetch();
    },
    windowFocused() {
      request(options.projects.projects().map((project) => project.id));
      if (options.clock.now() - lastFetch >= FOCUS_FETCH_GAP_MS) startFetch();
    },
    refresh(workspaceId) {
      const record = options.projects.workspaces().find((candidate) => candidate.id === workspaceId);
      if (record !== undefined) request([record.projectId]);
    },
    async idle() {
      // A fetch asks for scans, and a scan may be asked for during one; wait until both rest.
      for (;;) {
        const busy = [fetching, draining].filter((work) => work !== null);
        if (busy.length === 0) return;
        await Promise.all(busy);
      }
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async close() {
      closed = true;
      cancelFetchTimer?.();
      stop.abort();
      await fetching;
      await draining;
    },
  };
}

/**
 * The branch and detached commit to show for a listed worktree.
 *
 * @remarks
 * A detached worktree shows its short commit when hovered (SPEC-0001, "命名").
 *
 * @sideEffects none
 * @param worktree - The listed worktree, if it was listed.
 * @returns The branch and short head.
 */
function branchOf(worktree: ListedWorktree | undefined): Pick<Scanned, "branch" | "head"> {
  // Stryker disable next-line ObjectLiteral: the list shows a missing branch and head as `null` too.
  if (worktree === undefined) return { branch: null, head: null };
  return { branch: worktree.branch, head: worktree.branch === null ? worktree.head.slice(0, 7) : null };
}

/**
 * When each worktree of a repository was created.
 *
 * @remarks
 * Each worktree has an administrative directory under `<common>/worktrees/`, whose `gitdir`
 * names the worktree's `.git` file; the directory's birth time is when `git worktree add` ran.
 * Unreadable entries are skipped.
 *
 * @sideEffects Reads the repository's administrative files.
 * @param common - The repository's common git directory.
 * @returns Creation times by worktree directory.
 */
async function creationTimes(common: string): Promise<Map<string, number>> {
  const times = new Map<string, number>();
  const admin = join(common, "worktrees");
  // Stryker disable next-line ArrayDeclaration: when the folder cannot be read, no entry under it can, so any other name is skipped as unreadable.
  for (const name of await readdir(admin).catch(() => [])) {
    try {
      const gitdir = await readFile(join(admin, name, "gitdir"), "utf8");
      const info = await stat(join(admin, name));
      // Stryker disable next-line MethodExpression: the line end is in the last part of the path, which `dirname` drops.
      times.set(dirname(gitdir.trim()), Math.floor(info.birthtimeMs));
    } catch {
      // Not a worktree's entry, or one being removed: skipped.
    }
  }
  return times;
}

/**
 * The ref of a project's main branch.
 *
 * @remarks
 * The project's own setting, compared on `origin`, or where `origin/HEAD` points; nothing
 * else (domain-model, "已决定 15").
 *
 * @sideEffects Runs git.
 * @param project - The project.
 * @param run - Runs git in the project.
 * @returns The ref, or `null`.
 */
export async function mainBranchRef(
  project: ProjectRecord,
  run: (...args: string[]) => Promise<{ readonly code: number; readonly stdout: string } | null>,
): Promise<string | null> {
  if (project.mainBranch !== null) return `refs/remotes/origin/${project.mainBranch}`;
  const head = await run("symbolic-ref", "--quiet", "refs/remotes/origin/HEAD");
  return head?.code === 0 ? head.stdout.trim() : null;
}

/**
 * Whether a path is an existing directory.
 *
 * @remarks
 * A worktree git still lists may have lost its directory.
 *
 * @sideEffects Reads the file system.
 * @param path - The path.
 * @returns Whether it is a directory.
 */
async function isDirectory(path: string): Promise<boolean> {
  return (await stat(path).catch(() => null))?.isDirectory() === true;
}

/**
 * What to log about a failed scan or fetch.
 *
 * @remarks
 * A git failure is logged by its reason only, never git's output, which may name private paths
 * or remotes; anything else is a host bug and is logged whole.
 *
 * @sideEffects none
 * @param error - What was thrown.
 * @returns The log fields.
 */
function failureFields(error: unknown): Record<string, unknown> {
  return error instanceof GitError ? { command: error.command, reason: error.reason } : { err: error };
}
