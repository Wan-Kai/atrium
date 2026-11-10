import type { ChangesService } from "../changes/changes-service";
import type { WorkspaceFiles } from "../files/workspace-files";
import type { AttachmentStore } from "./attachments";
import {
  type Command,
  CommandError,
  type CommandResult,
  type CommandType,
  type ErrorInfo,
  isDirectionId,
  type PromptCommand,
  type SteerCommand,
  parseClientMessage,
} from "@atrium/protocol";
import { type Tracer, context, trace } from "@opentelemetry/api";
import type { Logger } from "../platform/logger";
import { contextFromTraceparent, inSpan } from "../platform/tracing";
import type { IndexCommands } from "../sessions/index-commands";
import type { SessionCommands } from "../sessions/session-commands";
import type { StudyCommands } from "../study/study-commands";
import type { ReplyTranslations } from "../sessions/reply-translation";
import type { InstallService } from "../setup/install-service";
import type { LoginService } from "../setup/login-service";
import type { PiLatestService } from "../setup/pi-latest";
import type { SetupService } from "../setup/setup-service";
import type { PiConfig } from "../setup/pi-config";
import type { Connection } from "./connection";
import { PHONE_STEP_TEXT_LIMIT, phoneMayRun } from "./remote-policy";
import type { ReceiptBook } from "../remote/receipts";
import type { ReviewHub } from "../reviews/review-hub";
import type { ScheduleCommands } from "../tasks/schedule-commands";
import type { TaskCommands } from "../tasks/task-commands";
import type { VisualService } from "../visuals/visual-service";

/**
 * The remote-access commands of the desktop's "手机" page (SPEC-0005, "给本机界面的命令和事件").
 *
 * @remarks
 * Defined here so the server knows only this shape; `remote/` implements it. Failures are thrown
 * as `CommandError`. Only local connections reach them: a phone is answered `local_only` first.
 */
export interface RemoteCommands {
  /** The remote state; `watch` starts or stops `remote_updated` for the connection. */
  get(connectionId: string, watch: boolean | undefined): CommandResult<"get_remote">;
  set(enabled: boolean, relay: string | undefined): Promise<CommandResult<"set_remote">>;
  testRelay(): Promise<CommandResult<"test_relay">>;
  startPairing(): CommandResult<"start_pairing">;
  cancelPairing(): CommandResult<"cancel_pairing">;
  confirmPairing(pairingId: string, accept: boolean): Promise<CommandResult<"confirm_pairing">>;
  renameDevice(deviceId: string, name: string): Promise<CommandResult<"rename_device">>;
  revokeDevice(deviceId: string): Promise<CommandResult<"revoke_device">>;
  resetIdentity(): Promise<CommandResult<"reset_remote_identity">>;
  /** A connection closed; it watches nothing more. */
  unwatch(connectionId: string): void;
}

/** What the router needs from the rest of the host. */
export interface RouterOptions {
  readonly sessions: SessionCommands;
  /** Independent reply translation, owned by the requesting connection. */
  readonly translations: Pick<ReplyTranslations, "translate" | "cancel">;
  /** Images uploaded ahead of their messages. */
  readonly attachments: AttachmentStore;
  /** What each connection shows of workspaces' git changes. */
  readonly changes: Pick<ChangesService, "watchChanges" | "watchDiff">;
  /** A workspace's files, for the right panel's file tree and the viewer tabs. */
  readonly files: WorkspaceFiles;
  /** Inline visuals: their addresses and the messages sent from them (SPEC-0007). */
  readonly visuals: Pick<VisualService, "resolve" | "send">;
  readonly index: IndexCommands;
  /** Learning directions (SPEC-0008). */
  readonly study: Pick<
    StudyCommands,
    | "createDirection"
    | "renameDirection"
    | "pinDirection"
    | "unpinDirection"
    | "archiveDirection"
    | "restoreDirection"
    | "startStudySession"
    | "markStudyStep"
    | "markStudyGap"
    | "upgradeStudy"
    | "restoreStudySessions"
  >;
  /** First launch and the settings. */
  readonly setup: Pick<SetupService, "check">;
  /** Ordinary pi JSON files, excluding credentials. */
  readonly piConfig: PiConfig;
  /** Signing in and out through pi. */
  readonly logins: Pick<LoginService, "login" | "answer" | "cancel" | "logout">;
  /** Installing and updating pi and Node. */
  readonly installs: Pick<InstallService, "start" | "cancel">;
  /** The latest pi. */
  readonly piLatest: Pick<PiLatestService, "check">;
  /** Remote access, for the local "手机" page. */
  readonly remote: RemoteCommands;
  /** Tasks and their graphs (SPEC-0006); a phone may only list and open them. */
  readonly tasks: TaskCommands;
  readonly schedules: ScheduleCommands;
  /** The reviews waiting for a verdict (ADR-0018). */
  readonly reviews: Pick<ReviewHub, "answer">;
  /** A phone's `prompt` and `steer` run at most once per request id (SPEC-0005, "MP4b 定的细节"). */
  readonly receipts: ReceiptBook;
  readonly tracer: Tracer;
  readonly logger: Logger;
  /**
   * The container a session is filed under, so a phone's command on a learning direction's
   * session is refused (SPEC-0008, "ML1 定的细节"); `undefined` for a session not known.
   */
  readonly containerOfSession: (sessionId: string) => string | undefined;
}

/** Handles one decoded message from an authenticated client. */
export type Route = (connection: Connection, message: unknown) => Promise<void>;

/**
 * Creates the function that answers every command a client sends.
 *
 * @remarks
 * Every command gets exactly one response (SPEC-0001, "应答"): its result, or an error code when
 * the message is invalid, the command unknown, or its handler throws `CommandError`. Anything else
 * a handler throws is a host bug: it is logged with the command's trace and answered with
 * `internal_error`, never with the error's text. Each command runs in a `command <type>` span whose
 * parent is the command's own `traceparent`, linked to the connection's trace rather than nested in
 * it, so one long-lived connection does not collect every operation into one trace. `ping` and
 * `report_client_issue` are answered here; session commands go to the session layer, list commands
 * to the index commands (domain-model §8), first launch's to the setup service. Before a command is answered, the list changes waiting
 * go to its connection, so the answer finds the list already changed by it (SPEC-0001, "先读到自己
 * 的写"). The returned promise never rejects.
 *
 * @sideEffects none until called; then starts a span, runs the handler, sends list changes and a
 * response, and logs.
 * @param options - Session commands, tracer and logger.
 * @returns The route function.
 */
export function createRouter(options: RouterOptions): Route {
  /**
   * Runs one valid command and returns its result.
   *
   * @remarks
   * The `switch` is exhaustive over `Command`, so a new command type does not compile until it is
   * routed. A phone's command that is not on its allowlist is answered `local_only` first.
   *
   * @sideEffects Whatever the handler does.
   * @param connection - The connection that sent it.
   * @param command - The command.
   * @returns The command's result.
   */
  async function run(connection: Connection, command: Command): Promise<CommandResult<CommandType>> {
    // A phone runs only what the allowlist gives it (SPEC-0005, "远程客户端能用的命令").
    if (connection.origin === "remote" && !phoneMayRun(command)) throw new CommandError("local_only");
    // Nor anything of learning mode, whatever command names it (SPEC-0008, "ML1 定的细节").
    if (connection.origin === "remote" && namesLearning(command, options.containerOfSession)) {
      throw new CommandError("local_only");
    }
    switch (command.type) {
      case "ping":
        return {};
      case "report_client_issue":
        options.logger.warn(
          { client_id: connection.clientId, kind: command.kind, issue: command.message, details: command.details },
          "client issue",
        );
        return {};
      case "create_chat":
        return options.sessions.createChat(connection.clientId);
      case "create_session":
        return options.sessions.createSession(
          connection.clientId,
          command.containerId,
          command.go ?? true,
          command.child,
        );
      case "detach_session":
        return options.sessions.detachSession(command.sessionId);
      case "close_tab":
        return options.sessions.closeTab(connection.clientId, command.sessionId);
      case "select_container":
        return options.sessions.selectContainer(connection.clientId, command.containerId);
      case "archive_session":
        return options.sessions.archiveSession(command.sessionId);
      case "archive_chat":
        return options.sessions.archiveChat(command.chatId);
      case "restore_chat":
        return options.sessions.restoreChat(command.chatId);
      case "rename_session":
        return options.sessions.renameSession(command.sessionId, command.name);
      case "clear_attention":
        return options.sessions.clearAttention(command.sessionId);
      case "subscribe_index":
        return options.index.subscribeIndex(connection.id, command.cursor);
      case "add_project":
        return options.index.addProject(command.path);
      case "remove_project":
        return options.index.removeProject(command.projectId);
      case "rename_project":
        return options.index.renameProject(command.projectId, command.name);
      case "rename_workspace":
        return options.index.renameWorkspace(command.workspaceId, command.name);
      case "archive_workspace":
        return options.index.archiveWorkspace(command.workspaceId);
      case "restore_workspace":
        return options.index.restoreWorkspace(command.workspaceId);
      case "list_bases":
        return options.index.listBases(command.projectId);
      case "create_workspace":
        return options.index.createWorkspace(command.projectId, command.branch, command.base, command.alias);
      case "name_branch":
        return options.index.nameBranch(command.projectId, command.text, command.model, command.branch);
      case "rename_chat":
        return options.index.renameChat(command.chatId, command.name);
      case "pin_chat":
        return options.index.pinChat(command.chatId);
      case "unpin_chat":
        return options.index.unpinChat(command.chatId);
      case "create_direction":
        return options.study.createDirection(connection.clientId, command.text, command.model);
      case "rename_direction":
        return options.study.renameDirection(command.directionId, command.name);
      case "pin_direction":
        return options.study.pinDirection(command.directionId);
      case "unpin_direction":
        return options.study.unpinDirection(command.directionId);
      case "archive_direction":
        return options.study.archiveDirection(command.directionId);
      case "restore_direction":
        return options.study.restoreDirection(command.directionId);
      case "start_study_session": {
        const { directionId, kind, level, step, gap } = command;
        return options.study.startStudySession(connection.clientId, directionId, {
          kind,
          level,
          ...(step === undefined ? {} : { step }),
          ...(gap === undefined ? {} : { gap }),
        });
      }
      case "upgrade_study":
        return options.study.upgradeStudy(
          connection.clientId,
          command.directionId,
          command.level,
          command.archiveSessions,
        );
      case "restore_study_sessions":
        return options.study.restoreStudySessions(command.directionId, command.sessionIds);
      case "mark_study_step":
        return options.study.markStudyStep(
          command.directionId,
          command.level,
          command.step,
          command.mark,
          command.done,
        );
      case "mark_study_gap":
        return options.study.markStudyGap(command.directionId, command.gapId, command.fixed);
      case "retry_study_kickoff":
        return options.sessions.retryStudyKickoff(command.sessionId);
      case "window_focused":
        return options.index.windowFocused();
      case "watch_changes":
        options.changes.watchChanges(connection.id, command.workspaceIds);
        return {};
      case "watch_diff":
        options.changes.watchDiff(connection.id, command.target);
        return {};
      case "list_dir":
        return options.files.listDir(command.workspaceId, command.path);
      case "read_file":
        return options.files.readFile(command.workspaceId, command.path);
      case "resolve_visual":
        return options.visuals.resolve(connection.id, command.sessionId, command.path);
      case "send_visual_message": {
        const { type: _type, ...message } = command;
        return options.visuals.send(message);
      }
      case "translate_reply":
        return options.translations.translate(connection.id, command.translationId, command.sessionId, command.turnId);
      case "cancel_translation":
        await options.translations.cancel(connection.id, command.translationId);
        return {};
      case "set_preferences":
        return options.index.setPreferences({
          ...(command.setupDone === undefined ? {} : { setupDone: command.setupDone }),
          ...(command.appearance === undefined ? {} : { appearance: command.appearance }),
          ...(command.statusBar === undefined ? {} : { statusBar: command.statusBar }),
          ...(command.titleModel === undefined ? {} : { titleModel: command.titleModel }),
          ...(command.proxy === undefined ? {} : { proxy: command.proxy }),
          ...(command.inbox === undefined ? {} : { inbox: command.inbox }),
          ...(command.translationLanguage === undefined ? {} : { translationLanguage: command.translationLanguage }),
        });
      case "subscribe_sessions":
        return options.sessions.subscribe(connection.id, command.sessionIds, command.snapshot, command.resume);
      case "prompt":
        return once(options.receipts, connection, command, () =>
          options.attachments.use(connection.id, command.attachmentIds ?? [], (images) =>
            options.sessions.prompt(command, images),
          ),
        );
      case "edit_stopped_message":
        return options.attachments.use(connection.id, command.attachmentIds ?? [], (images) =>
          options.sessions.editStoppedMessage(command, images),
        );
      case "fetch_transcript":
        // A phone's page is cut to its short previews, and counted so, to hold more turns.
        return options.sessions.fetchTranscript(
          command,
          connection.origin === "remote" ? PHONE_STEP_TEXT_LIMIT : undefined,
        );
      case "fetch_step":
        return options.sessions.fetchStep(command);
      case "fetch_image":
        return options.sessions.fetchImage(command);
      case "open_session":
        return options.sessions.openSession(connection.clientId, command.sessionId);
      case "steer":
        return once(options.receipts, connection, command, () =>
          options.attachments.use(connection.id, command.attachmentIds ?? [], (images) =>
            options.sessions.steer(command, images),
          ),
        );
      case "stop":
        return options.sessions.stop(command.sessionId);
      case "resume_queue":
        return options.sessions.resumeQueue(command.sessionId);
      case "clear_queue":
        return options.sessions.clearQueue(command.sessionId);
      case "update_queued":
        return options.sessions.updateQueued(command.sessionId, command.itemId, command.text);
      case "remove_queued":
        return options.sessions.removeQueued(command.sessionId, command.itemId);
      case "remove_delivery":
        return options.sessions.removeDelivery(command.sessionId, command.deliveryId);
      case "resume_deliveries":
        return options.sessions.resumeDeliveries(command.sessionId, command.tree);
      case "steer_queued":
        return options.sessions.steerQueued(command.sessionId, command.itemId);
      case "answer_interaction":
        return options.sessions.answerInteraction(command.sessionId, command.interactionId, command.answer);
      case "answer_question":
        return options.sessions.answerQuestion(command.sessionId, command.questionId, command.answer);
      case "answer_review":
        await options.reviews.answer(command.sessionId, command.reviewId, command.verdict);
        return {};
      case "retry_run":
        return options.sessions.retryRun(command.sessionId);
      case "set_model":
        return options.sessions.setModel(command.sessionId, {
          providerId: command.providerId,
          modelId: command.modelId,
        });
      case "set_thinking_level":
        return options.sessions.setThinkingLevel(command.sessionId, command.level);
      case "set_fast":
        return options.sessions.setFast(command.sessionId, command.enabled);
      case "compact_session":
        return options.sessions.compactSession(command.sessionId, command.instructions);
      case "export_session":
        return options.sessions.exportSession(command.sessionId);
      case "fork_session":
        return options.sessions.forkSession(connection.clientId, command);
      case "list_commands":
        return options.sessions.listCommands(command.sessionId);
      case "search_files":
        return options.sessions.searchFiles(command.sessionId, command.query);
      case "upload_attachment":
        return { attachmentId: options.attachments.put(connection.id, command.mimeType, command.data) };
      case "list_models":
        return options.index.listModels(command.workspaceId, command.refresh ?? false);
      case "read_pi_config":
        return options.piConfig.read(command.workspaceId, command.name);
      case "save_pi_config":
        return options.piConfig.save(command.workspaceId, command.name, command.text, command.revision);
      case "check_setup":
        return options.setup.check(command.refresh ?? false);
      case "login":
        return options.logins.login({
          providerId: command.providerId,
          method: command.method,
          ...(command.key === undefined ? {} : { key: command.key }),
        });
      case "answer_login":
        options.logins.answer(command.loginId, command.promptId, command.value);
        return {};
      case "cancel_login":
        options.logins.cancel(command.loginId);
        return {};
      case "logout":
        await options.logins.logout(command.providerId);
        return {};
      case "install_pi":
      case "install_node":
      case "update_pi":
        return options.installs.start(command.type);
      case "cancel_install":
        options.installs.cancel(command.jobId);
        return {};
      case "check_pi_update":
        return options.piLatest.check();
      case "discover_projects":
        return options.index.discoverProjects();
      case "list_branches":
        return options.index.listBranches(command.projectId);
      case "set_main_branch":
        return options.index.setMainBranch(command.projectId, command.branch);
      case "list_tasks":
        return options.tasks.list(connection.id, command.watch);
      case "open_task":
        return options.tasks.open(connection.id, command.taskId);
      case "create_task":
        return options.tasks.create(command.sessionId, command.scope);
      case "start_task":
        return options.tasks.start(command.taskId);
      case "abandon_task":
        return options.tasks.abandon(command.taskId);
      case "approve_graph":
        return options.tasks.approveGraph(command.taskId);
      case "reject_graph":
        return options.tasks.rejectGraph(command.taskId);
      case "answer_human":
        return options.tasks.answerHuman(command.taskId, command.node, command.answer);
      case "rerun_node":
        return options.tasks.rerunNode(command.taskId, command.node);
      case "continue_node":
        return options.tasks.continueNode(command.taskId, command.node);
      case "pause_task":
        return options.tasks.pause(command.taskId);
      case "resume_task":
        return options.tasks.resume(command.taskId);
      case "cancel_task":
        return options.tasks.cancel(command.taskId);
      case "open_task_session":
        return options.tasks.openSession(command.taskId, command.sessionId);
      case "answer_archive":
        return options.tasks.answerArchive(command.taskId, command.answer);
      case "list_schedules":
        return options.schedules.list(connection.id, command.watch);
      case "pause_schedule":
        return options.schedules.pause(command.scheduleId);
      case "resume_schedule":
        return options.schedules.resume(command.scheduleId);
      case "run_schedule_now":
        return options.schedules.runNow(command.scheduleId);
      case "delete_schedule":
        return options.schedules.remove(command.scheduleId);
      case "edit_schedule":
        return options.schedules.edit(command.scheduleId);
      case "get_remote":
        return options.remote.get(connection.id, command.watch);
      case "set_remote":
        return options.remote.set(command.enabled, command.relay);
      case "test_relay":
        return options.remote.testRelay();
      case "start_pairing":
        return options.remote.startPairing();
      case "cancel_pairing":
        return options.remote.cancelPairing();
      case "confirm_pairing":
        return options.remote.confirmPairing(command.pairingId, command.accept);
      case "rename_device":
        return options.remote.renameDevice(command.deviceId, command.name);
      case "revoke_device":
        return options.remote.revokeDevice(command.deviceId);
      case "reset_remote_identity":
        return options.remote.resetIdentity();
    }
    // Stryker disable next-line all: unreachable, since the switch covers every command type.
    throw new Error(`unrouted command ${String((command as { type: unknown }).type)}`);
  }

  /**
   * Turns what a handler threw into the error the client gets.
   *
   * @remarks
   * Only `CommandError` carries a code meant for the client; anything else is logged as a bug.
   *
   * @sideEffects Logs unexpected errors.
   * @param error - What the handler threw.
   * @param command - The command, for the log.
   * @returns The error to send.
   */
  function failure(error: unknown, command: Command): ErrorInfo {
    if (error instanceof CommandError) {
      options.logger.info({ command: command.type, code: error.code }, "command failed");
      // Stryker disable next-line ConditionalExpression,ObjectLiteral: JSON leaves out a `params` that is undefined either way.
      return error.params === undefined ? { code: error.code } : { code: error.code, params: error.params };
    }
    options.logger.error({ err: error, command: command.type }, "command crashed");
    return { code: "internal_error" };
  }

  /**
   * Sends a connection the list changes waiting for it, before a command's answer.
   *
   * @remarks
   * SPEC-0001 ("先读到自己的写"). The answer goes out even when this fails: a command without one
   * leaves the client waiting for good.
   *
   * @sideEffects Sends events; logs a failure.
   * @param connection - The connection.
   */
  function flush(connection: Connection): void {
    try {
      options.index.answering(connection.id);
    } catch (error) {
      options.logger.warn({ err: error }, "list changes not sent before an answer");
    }
  }

  return async (connection, message) => {
    const parsed = parseClientMessage(message);
    if (!parsed.ok) {
      context.with(connection.trace, () =>
        options.logger.warn({ client_id: connection.clientId, code: parsed.code }, "command refused"),
      );
      connection.send({ type: "response", requestId: parsed.requestId, ok: false, error: { code: parsed.code } });
      return;
    }
    const { command } = parsed;
    const connectionSpan = trace.getSpanContext(connection.trace);
    await inSpan(
      options.tracer,
      `command ${command.type}`,
      async (span) => {
        span.setAttribute("client.id", connection.clientId);
        try {
          const result = await run(connection, command);
          flush(connection);
          connection.send({ type: "response", requestId: command.requestId, ok: true, result });
        } catch (error) {
          const info = forOrigin(connection, failure(error, command));
          span.setAttribute("command.error", info.code);
          flush(connection);
          connection.send({ type: "response", requestId: command.requestId, ok: false, error: info });
        }
      },
      contextFromTraceparent(command.traceparent),
      connectionSpan === undefined ? [] : [{ context: connectionSpan }],
    );
  };
}

/**
 * Runs a message command, through the phone's receipts when a phone sent it.
 *
 * @remarks
 * The Mac's `requestId` is not random, so the Mac takes no receipt (SPEC-0005, "协议改动" 4).
 *
 * @sideEffects Whatever `execute` does; a phone's also writes its receipt.
 * @param receipts - The phones' receipts.
 * @param sender - The connection.
 * @param message - The `prompt` or `steer`.
 * @param execute - Runs it.
 * @returns Its result.
 */
function once(
  receipts: ReceiptBook,
  sender: Connection,
  message: PromptCommand | SteerCommand,
  execute: () => Promise<CommandResult<"prompt"> | CommandResult<"steer">>,
): Promise<CommandResult<"prompt"> | CommandResult<"steer">> {
  return sender.deviceId === null ? execute() : receipts.run(sender.deviceId, message, execute);
}

/** The fields of a command that name a session, or a container a session can be in. */
const SESSION_FIELDS = new Set(["sessionId", "parentSessionId"]);
const CONTAINER_FIELDS = new Set(["containerId", "workspaceId", "directionId"]);

/**
 * Whether a command names a learning direction or a session in one, anywhere in it.
 *
 * @remarks
 * A phone sees nothing of learning mode (SPEC-0008, "ML1 定的细节", option A). Checked once for
 * every command rather than in each handler, so no command is missed: every field that names a
 * session (`sessionId`, `parentSessionId`, the `sessionIds` of a subscription and each resume
 * point's) or a container (`containerId`, `workspaceId`, `directionId`), at any depth.
 *
 * @sideEffects none
 * @param value - The command, or a part of it.
 * @param containerOf - The container a session is filed under.
 * @returns Whether it names one.
 */
function namesLearning(value: unknown, containerOf: (sessionId: string) => string | undefined): boolean {
  if (Array.isArray(value)) return value.some((item) => namesLearning(item, containerOf));
  if (typeof value !== "object" || value === null) return false;
  return Object.entries(value).some(([key, field]) => {
    const sessions = key === "sessionIds" && Array.isArray(field) ? field : SESSION_FIELDS.has(key) ? [field] : [];
    if (sessions.some((id) => typeof id === "string" && isLearning(containerOf(id)))) return true;
    if (CONTAINER_FIELDS.has(key) && typeof field === "string" && isLearning(field)) return true;
    return namesLearning(field, containerOf);
  });
}

/**
 * Whether a container is a learning direction.
 *
 * @remarks
 * By its id's prefix (`lrn_`, domain-model §1).
 *
 * @sideEffects none
 * @param containerId - The container, if any.
 * @returns Whether.
 */
function isLearning(containerId: string | undefined): boolean {
  return containerId !== undefined && isDirectionId(containerId);
}

/**
 * The error as the connection may see it: a phone is not told a session's directory.
 *
 * @remarks
 * `session_cwd_missing` names the path pi could not find; paths stay on the Mac (security.md,
 * "宿主远程访问").
 *
 * @sideEffects none
 * @param connection - Who gets it.
 * @param info - The error.
 * @returns What to send.
 */
function forOrigin(connection: Connection, info: ErrorInfo): ErrorInfo {
  return connection.origin === "remote" && info.code === "session_cwd_missing" ? { code: info.code } : info;
}
