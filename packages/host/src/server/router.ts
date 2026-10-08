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
import type { SessionCommands } from "../sessions/session-commands";
import type { Connection } from "./connection";

/** What the router needs from the rest of the host. */
export interface RouterOptions {
  readonly sessions: SessionCommands;
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
 * `report_client_issue` are answered here; session commands go to the session layer (domain-model
 * §8). The returned promise never rejects.
 *
 * @sideEffects none until called; then starts a span, runs the handler, sends a response and logs.
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
        return options.sessions.createChat(connection.id);
      case "subscribe_sessions":
        return options.sessions.subscribe(connection.id, command.sessionIds);
      case "prompt":
        return options.sessions.prompt(command);
      case "fetch_transcript":
        return options.sessions.fetchTranscript(command);
      case "fetch_step":
        return options.sessions.fetchStep(command);
      case "list_recent_sessions":
        return options.sessions.listRecentSessions(command.limit);
      case "open_session":
        return options.sessions.openSession(command.sessionId);
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
          connection.send({ type: "response", requestId: command.requestId, ok: true, result });
        } catch (error) {
          const info = failure(error, command);
          span.setAttribute("command.error", info.code);
          connection.send({ type: "response", requestId: command.requestId, ok: false, error: info });
        }
      },
      contextFromTraceparent(command.traceparent),
      connectionSpan === undefined ? [] : [{ context: connectionSpan }],
    );
  };
}
