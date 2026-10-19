import { CommandError } from "@atrium/client";
import { type StoreApi, createStore } from "zustand/vanilla";
import { describeWorktreeError } from "../state/new-workspace";

/** A child conversation being opened: under which session, and from which turn when it carries the turns. */
export interface ChildRequest {
  readonly parentSessionId: string;
  /** The turn it carries the conversation up to; `null` for an empty child. */
  readonly turnId: string | null;
}

/** The page's request, made on first use; see `pageNewChild`. */
let page: StoreApi<ChildRequest | null> | undefined;

/**
 * The child conversation the page is asking about, if any.
 *
 * @remarks
 * One for the page, as a reply's "↳" and the tab bar's "+" menu open the same dialog, which the
 * workbench shows (SPEC-0002, "第一步 · 入口").
 *
 * @sideEffects Creates the store on first use.
 * @returns The store.
 */
export function pageNewChild(): StoreApi<ChildRequest | null> {
  page ??= createStore<ChildRequest | null>(() => null);
  return page;
}

/**
 * Asks for a child conversation, opening the dialog.
 *
 * @remarks
 * See `pageNewChild`.
 *
 * @sideEffects Updates the page's request.
 * @param request - Under which session, and from which turn.
 */
export function askForChild(request: ChildRequest): void {
  // Stryker disable next-line BooleanLiteral: a request has every field, so merging it in gives the same state.
  pageNewChild().setState(request, true);
}

/**
 * The child kept when opening it failed after pi wrote its file, if that is how it failed.
 *
 * @remarks
 * A fork into a new worktree whose pi did not start once it wrote the child's file keeps the
 * child under its parent, and `fork_failed` names it (SPEC-0002, "带上下文的子对话怎么做出来").
 *
 * @sideEffects none
 * @param error - What `fork_session` rejected with.
 * @returns The child's id, or `null`.
 */
export function keptChild(error: unknown): string | null {
  if (!(error instanceof CommandError) || error.code !== "fork_failed") return null;
  const kept = error.params?.["sessionId"];
  return typeof kept === "string" ? kept : null;
}

/**
 * Explains why a child conversation could not be opened, in Chinese.
 *
 * @remarks
 * The host sends codes only (SPEC-0002, "接口与数据"); a new worktree's failures read as creating
 * a workspace's do. A child kept though its pi failed is told otherwise (`keptChild`).
 *
 * @sideEffects none
 * @param error - What `create_session` or `fork_session` rejected with.
 * @returns The sentence.
 */
export function describeChildError(error: unknown): string {
  const worktree = describeWorktreeError(error);
  if (worktree !== null) return worktree;
  if (!(error instanceof CommandError)) return "没能开子对话";
  const words: Readonly<Record<string, string>> = {
    child_place_invalid: "这里只能放在当前位置",
    session_busy: "运行中不能开带上下文的子对话",
    session_is_draft: "主对话还没有消息，发一条再开子对话",
    session_not_found: "主对话已经不在了",
    session_handed_off: "主对话已在终端中继续，先接回来",
    turn_not_found: "没能开子对话：找不到这一轮",
    fork_failed: "没能开子对话：pi 出错了",
  };
  return words[error.code] ?? "没能开子对话";
}
