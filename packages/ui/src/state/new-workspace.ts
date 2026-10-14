import { type AtriumClient, CommandError } from "@atrium/client";
import type { CommandResult, ModelRef, ThinkingLevel } from "@atrium/protocol";
import { type StoreApi, createStore } from "zustand/vanilla";
import type { CompressedImage } from "../chat/images";
import { type ShownModel, shownModel } from "../chat/model-choice";
import type { Drafts } from "./drafts";

// The "新建工作区" page and what sending from it sets going (SPEC-0001, "M1.11 的新建工作区").

/** Where the page's first message goes: a new worktree, or a workspace already there. */
type WorkspaceChoice =
  | {
      readonly kind: "new";
      /** The branch's name; `null` for one a model gives it by the first message (SPEC-0001, "AI 起分支名"). */
      readonly branch: string | null;
      /** The base chosen; `null` for the default, once the bases are known (`defaultBase`). */
      readonly base: string | null;
    }
  | { readonly kind: "existing"; readonly workspaceId: string };

/** The model and thinking level chosen on the page, set on the session before the message; `null` for the usual. */
export interface PageModel {
  readonly ref: ModelRef | null;
  readonly level: ThinkingLevel | null;
}

/** The page, while it is open. */
export interface NewWorkspacePage {
  readonly projectId: string;
  readonly choice: WorkspaceChoice;
  readonly model: PageModel;
  /** The launch sent from the page last, shown on it until its session exists. */
  readonly launchId: string | null;
}

/** An image of the first message, uploaded. */
export interface LaunchImage {
  readonly attachmentId: string;
  readonly image: CompressedImage;
}

/** One step of a launch, as its timeline names it. */
export type LaunchStep = "name" | "worktree" | "session" | "message";

/** What sending from the page set going, until its message has gone. */
export interface Launch {
  readonly id: string;
  /**
   * The new worktree's branch and base, for the steps' words; `null` into a workspace already
   * there. The branch is `null` until named.
   */
  readonly worktree: { readonly branch: string | null; readonly base: string } | null;
  /** How the `name` step named the branch: by the model, or randomly when it could not; `null` until then. */
  readonly named: "model" | "random" | null;
  readonly steps: readonly LaunchStep[];
  /** How many steps are done. */
  readonly done: number;
  /** Why the step after the done ones failed; `undefined` while none has. */
  readonly failure: unknown;
  readonly text: string;
  readonly images: readonly LaunchImage[];
  readonly workspaceId: string | null;
  readonly sessionId: string | null;
}

/** The page and the launches going on. */
export interface NewWorkspaceState {
  readonly page: NewWorkspacePage | null;
  readonly launches: readonly Launch[];
}

/** The words a suggested branch is made of: `atrium/<adjective>-<animal>`. */
const ADJECTIVES = [
  "brave",
  "calm",
  "eager",
  "gentle",
  "happy",
  "jolly",
  "keen",
  "lucky",
  "merry",
  "nimble",
  "proud",
  "quick",
  "quiet",
  "sharp",
  "steady",
  "swift",
] as const;
const ANIMALS = [
  "badger",
  "crane",
  "falcon",
  "fox",
  "heron",
  "koala",
  "lynx",
  "marten",
  "otter",
  "panda",
  "quail",
  "raven",
  "robin",
  "seal",
  "tiger",
  "wren",
] as const;

/**
 * A branch name for a new worktree, like `atrium/brave-otter`.
 *
 * @remarks
 * SPEC-0001 ("M1.11 的新建工作区"): when the model could not name it, or there is no text to name
 * it by. Two words from sixteen each rarely meet one taken; the host refuses one that is.
 *
 * @sideEffects none
 * @param random - A number in [0, 1), as `Math.random` gives.
 * @returns The name.
 */
export function suggestBranch(random: () => number): string {
  const adjective = ADJECTIVES[Math.floor(random() * ADJECTIVES.length)] ?? ADJECTIVES[0];
  const animal = ANIMALS[Math.floor(random() * ANIMALS.length)] ?? ANIMALS[0];
  return `atrium/${adjective}-${animal}`;
}

/**
 * Where a new worktree starts unless another base is chosen.
 *
 * @remarks
 * The main branch on `origin`; without one, the local workspace's branch; else `HEAD`
 * (SPEC-0001, "M1.11 的新建工作区"). As a full ref (`baseRef`).
 *
 * @sideEffects none
 * @param bases - What `list_bases` answered.
 * @returns The base.
 */
export function defaultBase(bases: Pick<CommandResult<"list_bases">, "main" | "current">): string {
  if (bases.main !== null) return baseRef("remote", bases.main);
  return bases.current === null ? "HEAD" : baseRef("local", bases.current);
}

/**
 * The full ref of a branch `list_bases` names.
 *
 * @remarks
 * SPEC-0001 ("M1.11 的新建工作区"): `create_workspace` takes `refs/heads/…` or `refs/remotes/…`,
 * as a short name could be taken for a tag of the same name.
 *
 * @sideEffects none
 * @param kind - Whether the branch is local or remote.
 * @param name - Its short name, as `main` or `origin/main`.
 * @returns The ref.
 */
export function baseRef(kind: "local" | "remote", name: string): string {
  return `${kind === "local" ? "refs/heads" : "refs/remotes"}/${name}`;
}

/**
 * A base's short name, as the page and the errors write it.
 *
 * @remarks
 * See `baseRef`; `HEAD` is itself.
 *
 * @sideEffects none
 * @param ref - The full ref.
 * @returns The name.
 */
export function baseName(ref: string): string {
  return ref.replace(/^refs\/(?:heads|remotes)\//, "");
}

/**
 * The key of the page's box in the drafts.
 *
 * @remarks
 * One per project, so what was typed for one project does not go into another's worktree.
 *
 * @sideEffects none
 * @param projectId - The project.
 * @returns The key.
 */
export function pageDraftKey(projectId: string): string {
  return `new-workspace:${projectId}`;
}

/**
 * Creates the page's store: no page, no launch.
 *
 * @remarks
 * One for the window, like the drafts: the page and its launches outlive the components that
 * show them, as a launch goes on after the user leaves the page.
 *
 * @sideEffects none
 * @returns The store.
 */
export function createNewWorkspaceStore(): StoreApi<NewWorkspaceState> {
  return createStore<NewWorkspaceState>(() => ({ page: null, launches: [] }));
}

/**
 * Opens the page for a project, with a new worktree whose branch the model names.
 *
 * @remarks
 * Opening it again starts afresh, as the page is only a way in (SPEC-0001, "M1.11 的新建工作区").
 * A launch that failed before its session existed showed only on the page left, so it goes.
 *
 * @sideEffects Updates the store.
 * @param store - The store.
 * @param projectId - The project.
 */
export function openPage(store: StoreApi<NewWorkspaceState>, projectId: string): void {
  store.setState(({ launches }) => ({
    launches: launches.filter((one) => one.sessionId !== null || one.failure === undefined),
    page: {
      projectId,
      choice: { kind: "new", branch: null, base: null },
      model: { ref: null, level: null },
      launchId: null,
    },
  }));
}

/**
 * The model the page's button shows.
 *
 * @remarks
 * What a new session would start on (`shownModel`), with the model and level chosen on the page
 * over it; a model chosen without a level shows the level remembered for it.
 *
 * @sideEffects none
 * @param model - What the page has chosen.
 * @param preferences - The model chosen last and the levels remembered.
 * @param list - The models of where the session will run.
 * @returns The model, or `null` when there is nothing to show.
 */
export function pageModel(
  model: PageModel,
  preferences: Parameters<typeof shownModel>[1],
  list: Parameters<typeof shownModel>[2],
): ShownModel | null {
  const shown = shownModel(null, model.ref === null ? preferences : { ...preferences, lastModel: model.ref }, list);
  return shown === null || model.level === null ? shown : { ...shown, level: model.level };
}

/**
 * Leaves the page, if it is open.
 *
 * @remarks
 * Launches from it go on (SPEC-0001, "M1.11 的新建工作区").
 *
 * @sideEffects Updates the store.
 * @param store - The store.
 */
export function closePage(store: StoreApi<NewWorkspaceState>): void {
  if (store.getState().page !== null) store.setState({ page: null });
}

/**
 * Changes what the page has chosen.
 *
 * @remarks
 * The workspaces and bases are a project's own, so going to another project goes back to a new
 * worktree from the default base, keeping the branch's name, or else naming it by the message.
 *
 * @sideEffects Updates the store.
 * @param store - The store.
 * @param change - The fields to change.
 */
export function choose(
  store: StoreApi<NewWorkspaceState>,
  change: Partial<Pick<NewWorkspacePage, "projectId" | "choice" | "model">>,
): void {
  const { page } = store.getState();
  if (page === null) return;
  if (change.projectId === undefined || change.projectId === page.projectId) {
    store.setState({ page: { ...page, ...change } });
    return;
  }
  const branch = page.choice.kind === "new" ? page.choice.branch : null;
  store.setState({ page: { ...page, choice: { kind: "new", branch, base: null }, ...change } });
}

/**
 * The launch whose timeline shows over a session, while its message has not gone.
 *
 * @remarks
 * A failed one stays until the next send there dismisses it.
 *
 * @sideEffects none
 * @param state - The store's state.
 * @param sessionId - The session shown.
 * @returns The launch, if any.
 */
export function launchOver(state: NewWorkspaceState, sessionId: string | null): Launch | undefined {
  return sessionId === null ? undefined : state.launches.find((one) => one.sessionId === sessionId);
}

/**
 * Whether a launch still holds its session's box back from sending.
 *
 * @remarks
 * Until the first message has gone (SPEC-0001, "M1.11 的新建工作区"); a failed one lets the box send.
 *
 * @sideEffects none
 * @param shown - The launch.
 * @returns Whether to hold.
 */
export function holdsBack(shown: Launch | undefined): boolean {
  return shown !== undefined && shown.failure === undefined;
}

/**
 * Forgets a launch, as the next send in its session does once it failed.
 *
 * @remarks
 * See `launchOver`.
 *
 * @sideEffects Updates the store.
 * @param store - The store.
 * @param launchId - The launch.
 */
export function dismiss(store: StoreApi<NewWorkspaceState>, launchId: string): void {
  store.setState({ launches: store.getState().launches.filter((one) => one.id !== launchId) });
}

/** What a launch asks of the client. */
export type LaunchClient = Pick<
  AtriumClient,
  "nameBranch" | "createWorkspace" | "createSession" | "listCommands" | "setModel" | "setThinkingLevel" | "prompt"
>;

/**
 * Sends the page's first message: names the branch, creates the worktree, then the session, then
 * sends.
 *
 * @remarks
 * SPEC-0001 ("M1.11 的新建工作区"). The steps show on a timeline. A branch left to the model is
 * named by the message's text on the page's model (SPEC-0001, "AI 起分支名"); when that fails, for
 * whatever reason, or the message has no text, the name is random, and the launch goes on. While
 * the user is on the page, its button then shows the name, so sending again names no more. Once the worktree is there,
 * the page goes into it, so sending again does not make a second one. Once the session is there,
 * what was typed since moves into its box, and the page closes, as the host shows the session;
 * a user who left the page stays where they went (`go: false`). pi's start is waited for by
 * setting the model chosen, or else by listing its commands, as opening the session would take
 * the window there. A failure stops the steps and puts the message back into the box it came
 * from, or the session's once there is one, when that box is empty.
 *
 * @sideEffects Sends commands; updates the store and the drafts.
 * @param store - The store.
 * @param client - The client.
 * @param drafts - The page's drafts.
 * @param message - The message and its uploaded images.
 * @param newId - Makes the launch's id.
 * @param random - Picks a random branch name's words.
 */
export async function launch(
  store: StoreApi<NewWorkspaceState>,
  client: LaunchClient,
  drafts: Pick<Drafts, "handOver" | "restore">,
  message: { readonly text: string; readonly images: readonly LaunchImage[] },
  newId: () => string,
  random: () => number = Math.random,
): Promise<void> {
  const page = store.getState().page;
  if (page === null) return;
  const { projectId, choice, model } = page;
  const id = newId();
  // Stryker disable next-line ConditionalExpression: only a new worktree has a branch, so the next check holds too.
  const naming = choice.kind === "new" && choice.branch === null && message.text.trim() !== "";
  const worktree =
    choice.kind === "new"
      ? { branch: naming ? null : (choice.branch ?? suggestBranch(random)), base: choice.base ?? "HEAD" }
      : null;
  let steps: LaunchStep[] = ["session", "message"];
  if (worktree !== null) steps = naming ? ["name", "worktree", ...steps] : ["worktree", ...steps];
  const started: Launch = {
    id,
    worktree,
    named: null,
    steps,
    done: 0,
    failure: undefined,
    ...message,
    workspaceId: choice.kind === "existing" ? choice.workspaceId : null,
    sessionId: null,
  };
  store.setState(({ launches }) => ({
    page: { ...page, launchId: id },
    launches: [...launches.filter((one) => one.id !== page.launchId), started],
  }));
  /**
   * Changes the launch.
   *
   * @remarks
   * The launch may have been dismissed meanwhile; then nothing changes.
   *
   * @sideEffects Updates the store.
   * @param change - The fields to change.
   */
  const update = (change: Partial<Launch>): void =>
    store.setState(({ launches }) => ({
      launches: launches.map((one) => (one.id === id ? { ...one, ...change } : one)),
    }));
  /**
   * Whether the user is still on the page this launch was sent from.
   *
   * @remarks
   * Leaving the page, or sending from it again, ends it.
   *
   * @sideEffects none
   * @returns Whether.
   */
  const onPage = (): boolean => store.getState().page?.launchId === id;
  let sessionId: string | null = null;
  try {
    let workspaceId = started.workspaceId;
    if (worktree !== null) {
      let { branch } = worktree;
      if (branch === null) {
        const named = await client.nameBranch(projectId, message.text, model.ref).then(
          (answer) => ({ branch: answer.branch, named: "model" as const }),
          () => ({ branch: suggestBranch(random), named: "random" as const }),
        );
        ({ branch } = named);
        const now = store.getState().page;
        // Stryker disable next-line ConditionalExpression: the choices are held while naming, so it is still a new worktree.
        if (now?.launchId === id && now.choice.kind === "new") {
          store.setState({ page: { ...now, choice: { ...now.choice, branch } } });
        }
        update({ worktree: { ...worktree, branch }, named: named.named, done: 1 });
      }
      workspaceId = (await client.createWorkspace(projectId, branch, worktree.base)).workspaceId;
      const now = store.getState().page;
      if (now?.launchId === id) store.setState({ page: { ...now, choice: { kind: "existing", workspaceId } } });
      update({ workspaceId, done: steps.indexOf("worktree") + 1 });
    }
    // Set by now: given, or just created.
    // Stryker disable next-line StringLiteral: never used, as the line above says.
    const into = workspaceId ?? "";
    sessionId = (await client.createSession(into, onPage())).sessionId;
    update({ sessionId });
    // What was typed meanwhile goes with the session, unless the page was left: then it is the
    // next new workspace's.
    if (onPage()) {
      drafts.handOver(pageDraftKey(projectId), sessionId);
      store.setState({ page: null });
    }
    if (model.ref !== null) await client.setModel(sessionId, model.ref);
    if (model.level !== null) await client.setThinkingLevel(sessionId, model.level);
    if (model.ref === null && model.level === null) await client.listCommands(sessionId);
    update({ done: started.steps.length - 1 });
    const { images } = message;
    await client.prompt(
      sessionId,
      message.text,
      images.map((image) => image.attachmentId),
      images.map((image) => image.image.preview),
    );
    dismiss(store, id);
  } catch (failure) {
    update({ failure });
    const kept = message.images.map((image) => ({ ...image, id: crypto.randomUUID() }));
    drafts.restore(sessionId ?? pageDraftKey(projectId), message.text, kept);
  }
}

/**
 * Explains why the worktree could not be created, in Chinese.
 *
 * @remarks
 * SPEC-0001 ("M1.11 的新建工作区"); the session's and the message's steps fail as a send does.
 *
 * @sideEffects none
 * @param error - What `create_workspace` rejected with.
 * @returns The sentence, or `null` when it is not the worktree's.
 */
export function describeWorktreeError(error: unknown): string | null {
  if (!(error instanceof CommandError)) return null;
  if (error.code === "project_not_found") return "这个项目已经不在了";
  if (error.code !== "worktree_create_failed") return null;
  const params = error.params ?? {};
  const reasons: Readonly<Record<string, string>> = {
    branch_exists: "这个分支名已经有了，换一个",
    branch_invalid: "git 不接受这个分支名",
    base_missing: `找不到起点 ${baseName(String(params["base"]))}`,
    dir_taken: `目录 ${String(params["dir"])} 已经存在，换个分支名`,
    not_git: "这个项目不是 git 仓库",
  };
  return reasons[String(params["reason"])] ?? "没能建好工作区：git 出错了";
}
