import { z } from "zod";
import { ContainerId, SessionId, TerminalId } from "./ids";

/** The most lines of output the host keeps for one terminal (SPEC-0009, "历史与重放"). */
export const TERMINAL_HISTORY_LINES = 5000;

/** The most bytes of output the host keeps for one terminal, so one long line cannot bypass it. */
export const TERMINAL_HISTORY_BYTES = 8 * 1024 * 1024;

/** The most bytes one write may carry; the client sends keystrokes and pastes, not files. */
export const TERMINAL_WRITE_MAX = 64 * 1024;

/** The most terminals one container may have open at once (SPEC-0009, "接口与数据"). */
export const TERMINAL_MAX_PER_CONTAINER = 4;

/** Terminal sizes the host accepts, in columns and rows. */
export const TERMINAL_COLS = { min: 8, max: 500 } as const;

/** Terminal sizes the host accepts, in rows. */
export const TERMINAL_ROWS = { min: 4, max: 200 } as const;

/** How many columns wide a terminal is, as the window that opened it laid it out. */
export const TerminalCols = z.number().int().min(TERMINAL_COLS.min).max(TERMINAL_COLS.max);

/** How many rows tall a terminal is. */
export const TerminalRows = z.number().int().min(TERMINAL_ROWS.min).max(TERMINAL_ROWS.max);

/** Whether a terminal's process is still running. */
export const TerminalState = z.enum(["running", "exited"]);
export type TerminalState = z.infer<typeof TerminalState>;

/** Who asked for a terminal: the user, or an agent through its tool (SPEC-0009). */
export const TerminalOrigin = z.enum(["user", "agent"]);
export type TerminalOrigin = z.infer<typeof TerminalOrigin>;

/**
 * One terminal: a PTY owned by the host, shown as its own tab.
 *
 * @remarks
 * A terminal is not a session: it has no transcript, no branch, and no record in the index. It
 * belongs to a container for its directory, and it ends with the host or with its tab. The history
 * is not part of this shape; a client gets it once, by attaching.
 */
export const Terminal = z.strictObject({
  id: TerminalId,
  containerId: ContainerId,
  title: z.string().min(1).max(200),
  /** The directory the PTY was started in; the host resolves it from `containerId`, never from a client. */
  cwd: z.string().min(1).max(4096),
  cols: TerminalCols,
  rows: TerminalRows,
  state: TerminalState,
  /** The exit status once `state` is `exited`; `null` while running. */
  exitCode: z.number().int().nullable(),
  origin: TerminalOrigin,
  /** The session whose agent asked for it; only for `origin: "agent"`. */
  sessionId: SessionId.nullable(),
});
export type Terminal = z.infer<typeof Terminal>;

/** A terminal started; the client shows it as a tab. */
export const TerminalOpenedEvent = z.strictObject({
  type: z.literal("terminal_opened"),
  terminal: Terminal,
});
export type TerminalOpenedEvent = z.infer<typeof TerminalOpenedEvent>;

/**
 * Output from a terminal, to every client attached to it.
 *
 * @remarks
 * Only new bytes: an attaching client gets the retained history once, in the result of
 * `terminal_attach`, and then these. One event per read from the PTY, not per line.
 */
export const TerminalOutputEvent = z.strictObject({
  type: z.literal("terminal_output"),
  terminalId: TerminalId,
  data: z.string(),
});
export type TerminalOutputEvent = z.infer<typeof TerminalOutputEvent>;

/** A terminal's process ended; the tab stays and offers to start again. */
export const TerminalExitedEvent = z.strictObject({
  type: z.literal("terminal_exited"),
  terminalId: TerminalId,
  exitCode: z.number().int(),
});
export type TerminalExitedEvent = z.infer<typeof TerminalExitedEvent>;

/** A terminal was closed and its PTY released; the tab goes away. */
export const TerminalClosedEvent = z.strictObject({
  type: z.literal("terminal_closed"),
  terminalId: TerminalId,
});
export type TerminalClosedEvent = z.infer<typeof TerminalClosedEvent>;
