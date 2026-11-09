import {
  type Command,
  type CommandType,
  type HostMessage,
  type Layout,
  type SessionSummary,
  isDirectionId,
} from "@atrium/protocol";
import { forTransport, itemForTransport } from "../transcript/rules";

/** The longest text of a tool step that travels whole to a phone (SPEC-0005, "给手机推什么"). */
export const PHONE_STEP_TEXT_LIMIT = 512;

/** Whether a phone may send a command, or only the Mac. */
type Reach = "phone" | "local_only";

/**
 * What a phone may send: every command classified (SPEC-0005, "远程客户端能用的命令").
 *
 * @remarks
 * Typed over every command type, so a new command does not compile until someone decides; a test
 * checks the same against `COMMAND_TYPES`. The list only narrows what the app offers: a paired
 * phone is a trusted device that can make the agent run any tool.
 */
export const COMMAND_REACH = {
  // The handshake and subscriptions.
  ping: "phone",
  subscribe_index: "phone",
  subscribe_sessions: "phone",
  open_session: "phone",
  // Reading.
  fetch_transcript: "phone",
  fetch_step: "phone",
  fetch_image: "phone",
  list_models: "phone",
  list_commands: "phone",
  watch_changes: "phone",
  watch_diff: "phone",
  list_dir: "phone",
  read_file: "phone",
  // Sending and controlling.
  prompt: "phone",
  steer: "phone",
  stop: "phone",
  resume_queue: "phone",
  clear_queue: "phone",
  update_queued: "phone",
  remove_queued: "phone",
  steer_queued: "phone",
  remove_delivery: "phone",
  resume_deliveries: "phone",
  retry_run: "phone",
  answer_interaction: "phone",
  answer_question: "phone",
  // A session's settings.
  set_model: "phone",
  set_thinking_level: "phone",
  set_fast: "phone",
  compact_session: "phone",
  // Sessions and chats; `create_session` with `child` is refused in `phoneMayRun`.
  create_chat: "phone",
  create_session: "phone",
  select_container: "phone",
  close_tab: "phone",
  clear_attention: "phone",
  rename_session: "phone",
  archive_session: "phone",
  // Other.
  upload_attachment: "phone",
  report_client_issue: "phone",
  // Projects and workspaces.
  add_project: "local_only",
  remove_project: "local_only",
  rename_project: "local_only",
  discover_projects: "local_only",
  archive_workspace: "local_only",
  restore_workspace: "local_only",
  set_main_branch: "local_only",
  list_branches: "local_only",
  list_bases: "local_only",
  create_workspace: "local_only",
  name_branch: "local_only",
  translate_reply: "local_only",
  cancel_translation: "local_only",
  rename_workspace: "local_only",
  rename_chat: "local_only",
  // Pinning is offered on the phone too (SPEC-0005, "MP6b").
  pin_chat: "phone",
  unpin_chat: "phone",
  // Learning directions are the Mac's for now (SPEC-0008, "非目标": 手机端).
  create_direction: "local_only",
  rename_direction: "local_only",
  pin_direction: "local_only",
  unpin_direction: "local_only",
  archive_direction: "local_only",
  restore_direction: "local_only",
  start_study_session: "local_only",
  mark_study_step: "local_only",
  mark_study_gap: "local_only",
  retry_study_kickoff: "local_only",
  // Signing in and installing.
  login: "local_only",
  answer_login: "local_only",
  cancel_login: "local_only",
  logout: "local_only",
  install_pi: "local_only",
  install_node: "local_only",
  update_pi: "local_only",
  cancel_install: "local_only",
  check_setup: "local_only",
  check_pi_update: "local_only",
  // Configuration.
  read_pi_config: "local_only",
  save_pi_config: "local_only",
  set_preferences: "local_only",
  // Only for the Mac's own window.
  window_focused: "local_only",
  export_session: "local_only",
  // Not in the first version.
  edit_stopped_message: "local_only",
  fork_session: "local_only",
  detach_session: "local_only",
  archive_chat: "local_only",
  restore_chat: "local_only",
  search_files: "local_only",
  // Remote access itself is managed on the Mac.
  get_remote: "local_only",
  set_remote: "local_only",
  test_relay: "local_only",
  start_pairing: "local_only",
  cancel_pairing: "local_only",
  confirm_pairing: "local_only",
  rename_device: "local_only",
  revoke_device: "local_only",
  reset_remote_identity: "local_only",
  // The phone shows a visual as a card and renders nothing (SPEC-0007, "手机端").
  resolve_visual: "local_only",
  send_visual_message: "local_only",
} as const satisfies Record<CommandType, Reach>;

/**
 * Whether a phone may run a command.
 *
 * @remarks
 * By `COMMAND_REACH`; a new child conversation is not in the first version, so `create_session`
 * with `child` is the Mac's only (SPEC-0005, "远程客户端能用的命令").
 * Nothing of learning mode is a phone's either (SPEC-0008, "ML1 定的细节"): the router refuses
 * any command naming a direction or a session in one (`namesLearning`), and `forPhone` keeps them
 * out of what is sent.
 *
 * @sideEffects none
 * @param command - The command.
 * @returns Whether to run it; otherwise it is answered with `local_only`.
 */
export function phoneMayRun(command: Command): boolean {
  if (command.type === "create_session" && command.child !== undefined) return false;
  return COMMAND_REACH[command.type] === "phone";
}

/**
 * What goes to a phone: every kind of host message classified (SPEC-0005, "给手机推什么").
 *
 * @remarks
 * Applied where every message to a connection goes through, so broadcasts and what follows the
 * welcome are both filtered. `login_updated` carries sign-in addresses; the rest of what is held
 * back is about the Mac's own setup, or the "手机" page.
 */
export const PUSHED_TO_PHONE = {
  welcome: true,
  response: true,
  session_snapshot: true,
  session_resumed: true,
  run_started: true,
  run_settled: true,
  turn_started: true,
  step_added: true,
  step_delta: true,
  step_updated: true,
  turn_finished: true,
  notice_added: true,
  session_exited: true,
  control_updated: true,
  prompt_handled: true,
  model_updated: true,
  fast_updated: true,
  metrics_updated: true,
  index_snapshot: true,
  index_changes: true,
  changes_updated: true,
  diff_updated: true,
  plans_updated: true,
  login_updated: false,
  install_updated: false,
  install_output: false,
  pi_latest: false,
  credentials_changed: false,
  remote_updated: false,
  visual_changed: false,
} as const satisfies Record<HostMessage["type"], boolean>;

/**
 * Whether a host message may go to a phone.
 *
 * @remarks
 * See `PUSHED_TO_PHONE`.
 *
 * @sideEffects none
 * @param message - The message.
 * @returns Whether to send it.
 */
export function pushedToPhone(message: HostMessage): boolean {
  return PUSHED_TO_PHONE[message.type];
}

/**
 * A host message as a phone gets it: the list without what the phone never shows, and tool steps
 * as short previews.
 *
 * @remarks
 * Tool steps of snapshots and step events are cut to `PHONE_STEP_TEXT_LIMIT`; the phone fetches
 * one whole when it is opened (SPEC-0005, "给手机推什么").
 * The phone only ever shows sessions, workspaces and chats that are not archived, and has no use
 * for session file paths, so the list leaves them out: a snapshot drops them, and a change that
 * archived one becomes its removal. An upsert that takes an item out of the archive brings it back
 * whole (SPEC-0005, "给手机推什么"). Nothing of learning mode goes either (SPEC-0008, "ML1 定的细节",
 * option A): no learning direction, no session in one, no direction's tabs and no learning
 * directory, so no path of them leaves the Mac; a phone's commands that name one are refused in
 * the router, and a session's events reach only its subscribers, which a phone cannot be for a
 * direction's session. The ids of removed sessions stay, as the list does not say where those
 * were. Every other message is the same object.
 *
 * @sideEffects none
 * @param message - The message.
 * @returns The message for the phone.
 */
export function forPhone(message: HostMessage): HostMessage {
  if (message.type === "session_snapshot") {
    return { ...message, items: message.items.map((item) => itemForTransport(item, PHONE_STEP_TEXT_LIMIT)) };
  }
  if (message.type === "step_added" || message.type === "step_updated") {
    return { ...message, step: forTransport(message.step, PHONE_STEP_TEXT_LIMIT) };
  }
  if (message.type === "index_snapshot") {
    return {
      ...message,
      workspaces: message.workspaces.filter((workspace) => workspace.archivedAt === null),
      chats: message.chats.filter((chat) => chat.archivedAt === null),
      directions: [],
      sessions: message.sessions
        .filter((session) => !session.archived && !isDirectionId(session.containerId))
        .map(withoutFile),
      layout: withoutLearning(message.layout),
      // The phone shows no learning mode; the field only has to be there.
      learningDir: "~",
    };
  }
  if (message.type !== "index_changes") return message;
  const workspaces = split(
    message.workspaces,
    (workspace) => workspace.archivedAt !== null,
    (item) => item.id,
  );
  const chats = split(
    message.chats,
    (chat) => chat.archivedAt !== null,
    (item) => item.id,
  );
  const sessions = split(
    {
      upsert: message.sessions.upsert.filter((session) => !isDirectionId(session.containerId)),
      remove: message.sessions.remove,
    },
    (session) => session.archived,
    (item) => item.sessionId,
  );
  return {
    ...message,
    workspaces,
    chats,
    directions: { upsert: [], remove: [] },
    sessions: { ...sessions, upsert: sessions.upsert.map(withoutFile) },
    layout: message.layout === null ? null : withoutLearning(message.layout),
  };
}

/**
 * One collection's changes with its archived upserts turned into removals.
 *
 * @remarks
 * Removals the change already had come first, in their order.
 *
 * @sideEffects none
 * @param changes - The collection's changes.
 * @param archived - Whether an item is archived.
 * @param id - An item's id.
 * @returns The changes for the phone.
 */
function split<T>(
  changes: { readonly upsert: readonly T[]; readonly remove: readonly string[] },
  archived: (item: T) => boolean,
  id: (item: T) => string,
): { upsert: T[]; remove: string[] } {
  return {
    upsert: changes.upsert.filter((item) => !archived(item)),
    remove: [...changes.remove, ...changes.upsert.filter(archived).map(id)],
  };
}

/**
 * A session summary without its file path.
 *
 * @remarks
 * `state` still says whether the file exists.
 *
 * @sideEffects none
 * @param session - The summary.
 * @returns The same summary with `file` null.
 */
function withoutFile(session: SessionSummary): SessionSummary {
  return { ...session, file: null };
}

/**
 * A layout without learning directions: not where the client is, and without their tabs.
 *
 * @remarks
 * See `forPhone`.
 *
 * @sideEffects none
 * @param layout - The layout.
 * @returns The layout a phone gets.
 */
function withoutLearning(layout: Layout): Layout {
  return {
    container: layout.container !== null && isDirectionId(layout.container) ? null : layout.container,
    tabs: Object.fromEntries(Object.entries(layout.tabs).filter(([containerId]) => !isDirectionId(containerId))),
  };
}
