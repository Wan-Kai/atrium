import type { ChangesService } from "../changes/changes-service";
import type { WorkspaceFiles } from "../files/workspace-files";
import type { AttachmentStore } from "./attachments";
import {
  type Command,
  CommandError,
  type CommandResult,
  type CommandType,
  type ErrorInfo,
  parseClientMessage,
} from "@atrium/protocol";
import { type Tracer, context, trace } from "@opentelemetry/api";
import type { Logger } from "../platform/logger";
import { contextFromTraceparent, inSpan } from "../platform/tracing";
import type { IndexCommands } from "../sessions/index-commands";
import type { SessionCommands } from "../sessions/session-commands";
import type { InstallService } from "../setup/install-service";
import type { LoginService } from "../setup/login-service";
import type { PiLatestService } from "../setup/pi-latest";
import type { SetupService } from "../setup/setup-service";
import type { PiConfig } from "../setup/pi-config";
import type { Connection } from "./connection";

/** What the router needs from the rest of the host. */
export interface RouterOptions {
  readonly sessions: SessionCommands;
  /** Images uploaded ahead of their messages. */
  readonly attachments: AttachmentStore;
  /** What each connection shows of workspaces' git changes. */
  readonly changes: Pick<ChangesService, "watchChanges" | "watchDiff">;
  /** A workspace's files, for the right panel's file tree and the viewer tabs. */
  readonly files: WorkspaceFiles;
  readonly index: IndexCommands;
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
  readonly tracer: Tracer;
  readonly logger: Logger;
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
   * routed.
   *
   * @sideEffects Whatever the handler does.
   * @param connection - The connection that sent it.
   * @param command - The command.
   * @returns The command's result.
   */
  async function run(connection: Connection, command: Command): Promise<CommandResult<CommandType>> {
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
      case "hand_off":
        return options.sessions.handOff(command.sessionId);
      case "take_back":
        return options.sessions.takeBack(command.sessionId);
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
        return options.index.createWorkspace(command.projectId, command.branch, command.base);
      case "name_branch":
        return options.index.nameBranch(command.projectId, command.text, command.model);
      case "rename_chat":
        return options.index.renameChat(command.chatId, command.name);
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
      case "set_preferences":
        return options.index.setPreferences({
          ...(command.setupDone === undefined ? {} : { setupDone: command.setupDone }),
          ...(command.appearance === undefined ? {} : { appearance: command.appearance }),
          ...(command.statusBar === undefined ? {} : { statusBar: command.statusBar }),
          ...(command.titleModel === undefined ? {} : { titleModel: command.titleModel }),
          ...(command.proxy === undefined ? {} : { proxy: command.proxy }),
          ...(command.inbox === undefined ? {} : { inbox: command.inbox }),
        });
      case "subscribe_sessions":
        return options.sessions.subscribe(connection.id, command.sessionIds);
      case "prompt":
        return options.attachments.use(connection.id, command.attachmentIds ?? [], (images) =>
          options.sessions.prompt(command, images),
        );
      case "edit_stopped_message":
        return options.attachments.use(connection.id, command.attachmentIds ?? [], (images) =>
          options.sessions.editStoppedMessage(command, images),
        );
      case "fetch_transcript":
        return options.sessions.fetchTranscript(command);
      case "fetch_step":
        return options.sessions.fetchStep(command);
      case "fetch_image":
        return options.sessions.fetchImage(command);
      case "open_session":
        return options.sessions.openSession(connection.clientId, command.sessionId);
      case "steer":
        return options.attachments.use(connection.id, command.attachmentIds ?? [], (images) =>
          options.sessions.steer(command, images),
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
          const info = failure(error, command);
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
