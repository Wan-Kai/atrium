import { CommandError } from "@atrium/protocol";
import { GitError, type GitRunner } from "../platform/git";

/**
 * Where git looks for hooks when the host gives it none.
 *
 * @remarks
 * A path under `/dev/null` is never a directory, so git finds no hook there; it needs no folder
 * of the host's own to keep empty.
 */
const NO_HOOKS_PATH = "/dev/null";

/** The variables of a filter that run a command (gitattributes(5), "Filters"), and `required`, which makes git fail without it. */
const FILTER_VARIABLES = ["smudge", "clean", "process", "required"] as const;

/** What `git config --list --name-only -z` printed, as the names of the settings. */
type ConfigNames = readonly string[];

/**
 * Reads the names of the settings in some part of git's configuration.
 *
 * @remarks
 * `-z` ends each name with a NUL, so a name with a newline in it cannot pass as two; after the
 * last NUL comes an empty name, which matches nothing.
 *
 * @sideEffects Runs git.
 * @param git - git.
 * @param cwd - A directory of the repository.
 * @param scope - git's option choosing the files read: `--local`, `--worktree`, or none for all.
 * @returns The names.
 * @throws {GitError} `exit` when git cannot list them.
 */
async function configNames(git: GitRunner, cwd: string, scope: "--local" | "--worktree" | null): Promise<ConfigNames> {
  const listed = await git.run(["config", ...(scope === null ? [] : [scope]), "--name-only", "--list", "-z"], { cwd });
  if (listed.code !== 0) throw new GitError("config", "exit");
  return listed.stdout.split("\0");
}

/**
 * Whether the repository keeps a configuration for each worktree.
 *
 * @remarks
 * `git config --worktree` is an error unless `extensions.worktreeConfig` is on and there are
 * several worktrees (git-config(1)); with the extension off, `--local` is the whole of it.
 *
 * @sideEffects Runs git.
 * @param git - git.
 * @param cwd - A directory of the repository.
 * @returns Whether the extension is on.
 */
async function hasWorktreeConfig(git: GitRunner, cwd: string): Promise<boolean> {
  const value = await git.run(["config", "--local", "--type=bool", "--get", "extensions.worktreeConfig"], { cwd });
  return value.code === 0 && value.stdout.trim() === "true";
}

/**
 * Whether a setting is one that pulls in another file of settings.
 *
 * @remarks
 * `include.path` and `includeIf.<condition>.path`; git lowercases the section, not the condition.
 *
 * @sideEffects none
 * @param name - The setting's name.
 * @returns Whether it includes a file.
 */
function isInclude(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === "include.path" || lower.startsWith("includeif.");
}

/**
 * The names of the filters a configuration defines, and whether one has a name no `-c` can carry.
 *
 * @remarks
 * A filter is `filter.<name>.<variable>`, and its name may hold dots. One with `=` or a newline
 * in its name cannot be turned off with `-c filter.<name>.smudge=`, which git would read as
 * another setting.
 *
 * @sideEffects none
 * @param names - The setting names.
 * @returns The filters' names, and whether one cannot be turned off.
 */
function filtersOf(names: ConfigNames): { readonly filters: string[]; readonly unsafe: boolean } {
  const filters = new Set<string>();
  let unsafe = false;
  for (const name of names) {
    if (!name.toLowerCase().startsWith("filter.")) continue;
    const dot = name.lastIndexOf(".");
    const variable = name.slice(dot + 1).toLowerCase();
    // `filter.smudge` alone has no name, and git ignores it.
    if (dot <= "filter.".length - 1 || !FILTER_VARIABLES.some((known) => known === variable)) continue;
    const filter = name.slice("filter.".length, dot);
    if (filter.includes("=") || filter.includes("\n")) unsafe = true;
    else filters.add(filter);
  }
  return { filters: [...filters], unsafe };
}

/**
 * The `-c` options that keep git from running what a repository's configuration holds.
 *
 * @remarks
 * SPEC-0006 ("工作区"), security.md ("任务"): an agent can write the repository's `.git/config`
 * and `.git/hooks`, and git runs hooks, an fsmonitor and filters on checkout, commit and merge,
 * so the host would be running what the agent put there:
 * - `core.hooksPath` points where there are no hooks, `core.fsmonitor` is off;
 * - `log.showSignature`, `merge.verifySignatures` and `commit.gpgsign` are off, so git never runs the
 *   repository's `gpg.program` to check or make a signature;
 * - every filter configured anywhere git reads (the repository's, the user's, the system's)
 *   has `smudge`, `clean` and `process` emptied and `required` off, so files that go through
 *   git-lfs stay pointers and nothing runs. A filter named only in `.gitattributes` has no
 *   command and needs nothing;
 * - with `rejectIncludes`, a repository whose own configuration includes another file is refused,
 *   as is one with a filter name `-c` cannot carry: the included file is not the host's to read.
 *
 * @sideEffects Runs git (two or three listings of its configuration).
 * @param git - git.
 * @param cwd - A directory of the repository, or of one of its worktrees.
 * @param guard - Whether to refuse a repository whose configuration includes files.
 * @returns The options, to put before the subcommand.
 * @throws {CommandError} `worktree_config_unsafe`.
 * @throws {GitError} `exit` when git cannot list its configuration.
 */
export async function safeGitOptions(
  git: GitRunner,
  cwd: string,
  guard: { readonly rejectIncludes: boolean },
): Promise<string[]> {
  if (guard.rejectIncludes) {
    const own = [
      ...(await configNames(git, cwd, "--local")),
      ...((await hasWorktreeConfig(git, cwd)) ? await configNames(git, cwd, "--worktree") : []),
    ];
    if (own.some(isInclude)) throw new CommandError("worktree_config_unsafe", { reason: "include" });
  }
  const { filters, unsafe } = filtersOf(await configNames(git, cwd, null));
  if (unsafe) throw new CommandError("worktree_config_unsafe", { reason: "filter_name" });
  return [
    "-c",
    `core.hooksPath=${NO_HOOKS_PATH}`,
    "-c",
    "core.fsmonitor=false",
    // A signature is checked by running the repository's `gpg.program`; nothing the host runs may do that.
    "-c",
    "log.showSignature=false",
    "-c",
    "merge.verifySignatures=false",
    "-c",
    "commit.gpgsign=false",
    ...filters.flatMap((filter) => [
      "-c",
      `filter.${filter}.smudge=`,
      "-c",
      `filter.${filter}.clean=`,
      "-c",
      `filter.${filter}.process=`,
      "-c",
      `filter.${filter}.required=false`,
    ]),
  ];
}

/**
 * Runs a git command that may check out, commit or merge, without hooks, an fsmonitor or filters.
 *
 * @remarks
 * The one way the host runs such commands: `worktree add` for every new worktree, and the
 * `git commit` and `git merge` of tasks (SPEC-0006, "宿主自己跑的 git"). The cost is that the
 * project's own commit hooks do not run on these commits; checks belong to a task's `check` nodes.
 * See `safeGitOptions`.
 *
 * @sideEffects Runs git; whatever the command does.
 * @param git - git.
 * @param args - The subcommand and its arguments.
 * @param options - git's run options; `cwd` is also where the configuration is read.
 * @param guard - Whether to refuse a repository whose configuration includes files.
 * @returns What git did.
 * @throws {CommandError} `worktree_config_unsafe`.
 * @throws {GitError} When git cannot run, time out, or list its configuration.
 */
export async function runSafeGit(
  git: GitRunner,
  args: readonly string[],
  options: Parameters<GitRunner["run"]>[1],
  guard: { readonly rejectIncludes: boolean },
): ReturnType<GitRunner["run"]> {
  return git.run([...(await safeGitOptions(git, options.cwd, guard)), ...args], options);
}
