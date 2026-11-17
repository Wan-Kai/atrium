import { randomBytes } from "node:crypto";
import { basename } from "node:path";
import {
  type ContainerId,
  isChatId,
  type Terminal,
  TERMINAL_MAX_PER_CONTAINER,
  type TerminalId,
  TerminalOpenedEvent,
} from "@atrium/protocol";
import { CommandError } from "@atrium/protocol";
import { type Clock, trackedTimeout } from "../platform/clock";
import type { Logger } from "../platform/logger";
import type { ResourceTracker } from "../platform/resources";
import { createHistory, type TerminalHistory } from "./history";
import { type Reported, pasteAfter, reportedState, splitComplete } from "./reporting";
import { type ScreenReading, createScreen } from "./screen";
import type { PtyProcess, PtySpawn } from "./pty";

/** Something a connection should be told about a terminal. */
export type TerminalEvent =
  | { readonly type: "terminal_opened"; readonly terminal: Terminal }
  | { readonly type: "terminal_output"; readonly terminalId: TerminalId; readonly data: string }
  | { readonly type: "terminal_exited"; readonly terminalId: TerminalId; readonly exitCode: number }
  | { readonly type: "terminal_closed"; readonly terminalId: TerminalId };

/**
 * Who is asking.
 *
 * @remarks
 * Events go to `connectionId` (one socket), ownership follows `clientId`, which survives a
 * reconnect and a rebuilt tab. Sending by `clientId` reaches no socket; owning by
 * `connectionId` loses the terminal when the page reloads.
 */
interface Caller {
  readonly connectionId: string;
  readonly clientId: string;
}

/** How to open one terminal. */
interface OpenTerminalInput {
  readonly caller: Caller;
  readonly containerId: ContainerId;
  readonly cols: number;
  readonly rows: number;
  /** `agent` when a tool asked for it, with the session that asked. */
  readonly origin?: "user" | "agent";
  readonly sessionId?: string | null;
  /** A command to run once the shell is up; the shell's own prompt is what the user sees after. */
  readonly command?: string;
  /** A title the agent chose; otherwise the command's name or the directory's. */
  readonly title?: string;
}

/** What a terminal service needs from its owner. */
export interface TerminalServiceOptions {
  /** The login shell to start. */
  readonly shell: string;
  /** The directory a container's terminal opens in; `undefined` when the container is gone. */
  readonly dirOf: (containerId: string) => string | undefined;
  /** Used for chats, which have no directory of their own to open in (SPEC-0009). */
  readonly home: string;
  /** The host's environment, filtered by `terminalEnv`. */
  readonly env: Readonly<Record<string, string>>;
  readonly spawn: PtySpawn;
  /** Tells one connection about one terminal; output only ever goes to the attaching connection. */
  readonly send: (connectionId: string, event: TerminalEvent) => void;
  /** Tells every local connection, for a terminal an agent opened that belongs to no window. */
  readonly broadcast: (event: TerminalEvent) => void;
  readonly clock: Clock;
  /** Counts the timers a wait or a close holds, so leak tests see them. */
  readonly resources: ResourceTracker;
  readonly logger: Logger;
  /** The pids whose parent is `pid`; `ps` in production, a list in tests. */
  readonly childrenOf: (pid: number) => Promise<readonly number[]>;
  /** How long a closing terminal gets before `SIGKILL`. */
  readonly killGraceMs?: number;
}

/** Terminals on this host, one PTY each (SPEC-0009). */
export interface TerminalService {
  /** Opens a terminal and tells its connection. */
  open(input: OpenTerminalInput): Terminal;
  /** What a connection needs to show a terminal it may have missed. */
  attach(caller: Caller, terminalId: TerminalId): { terminal: Terminal; history: string };
  /** Writes bytes as if typed. */
  write(caller: Caller, terminalId: TerminalId, data: string): void;
  /** Tells the shell its new size. */
  resize(caller: Caller, terminalId: TerminalId, cols: number, rows: number): void;
  /**
   * Ends a terminal and releases it; resolves once the process is gone.
   *
   * @remarks
   * With something still running in it, the caller is answered `terminal_has_process` until it
   * passes `force`, so the question is asked by whoever can ask it (SPEC-0009).
   */
  close(caller: Caller, terminalId: TerminalId, force?: boolean): Promise<void>;
  /**
   * Reads a terminal's screen for its agent.
   *
   * @remarks
   * Only the agent that opened it may read it; a user's terminal is not for an agent to look at
   * (SPEC-0009, "agent 操作终端").
   */
  agentRead(
    sessionId: string,
    terminalId: TerminalId,
    lines?: number,
  ): Promise<
    ScreenReading & {
      readonly state: "running" | "exited";
      readonly exitCode: number | null;
      readonly reported: Reported | null;
    }
  >;
  /**
   * Types text, as a bracketed paste when the program asked for one; `submit` then presses Enter.
   *
   * @remarks
   * Resolves once the screen has settled after it, so a caller can read the result straight away
   * instead of waiting by hand (SPEC-0009, "agent 操作终端").
   */
  agentType(sessionId: string, terminalId: TerminalId, text: string, submit?: boolean): Promise<boolean>;
  /**
   * Presses one named key: `enter`, `esc`, `ctrl-c`, `ctrl-d`, `tab`, `shift-tab` or an arrow.
   *
   * @remarks
   * Keys that submit something wait for the screen to settle; arrows do not, so moving around a
   * menu stays quick.
   */
  agentKey(sessionId: string, terminalId: TerminalId, key: AgentKey): Promise<boolean>;
  /** Waits until the terminal's output has been quiet, or it ended, or the time ran out. */
  agentWait(
    sessionId: string,
    terminalId: TerminalId,
    options?: { readonly until?: "quiet" | "exited"; readonly quietMs?: number; readonly timeoutMs?: number },
  ): Promise<{ readonly quiet: boolean; readonly exited: boolean; readonly exitCode: number | null }>;
  /** Ends a terminal the agent opened. */
  agentClose(sessionId: string, terminalId: TerminalId): Promise<void>;
  /** Whether a program is running in the terminal, so closing it deserves a question. */
  hasForegroundProcess(terminalId: TerminalId): Promise<boolean>;
  /** Terminals this connection opened or attached to, in the order they were opened. */
  openTerminals(): readonly Terminal[];
  /**
   * The running terminals a client may still show.
   *
   * @remarks
   * Its own and the ones agents opened; another window's terminals are not its business
   * (SPEC-0009, "生命周期").
   */
  list(caller: Caller): readonly Terminal[];
  /** Ends every terminal, for host shutdown. */
  closeAll(): Promise<void>;
}

/** The keys an agent may press, and the bytes each one is (SPEC-0009, "agent 操作终端"). */
const AGENT_KEYS = {
  enter: "\r",
  esc: "\u001b",
  "ctrl-c": "\u0003",
  "ctrl-d": "\u0004",
  tab: "\t",
  // Back-tab: Claude Code cycles its permission mode on it.
  "shift-tab": "\u001b[Z",
  up: "\u001b[A",
  down: "\u001b[B",
  right: "\u001b[C",
  left: "\u001b[D",
} as const;

/** One key an agent may press. */
export type AgentKey = keyof typeof AGENT_KEYS;

/** How many terminals agents may have open in one container (SPEC-0009, "agent 操作终端"). */
const AGENT_TERMINALS_PER_CONTAINER = 6;

/** The most bytes one agent write may carry (SPEC-0009, "agent 操作终端"). */
const AGENT_WRITE_MAX = 4 * 1024;

/** How many agent writes a terminal accepts in one window. */
const AGENT_WRITES_PER_WINDOW = 20;

/** The rate limit's window. */
const AGENT_WRITE_WINDOW_MS = 1000;

/** How quiet a terminal must be before `agentWait` calls it settled. */
const AGENT_QUIET_MS = 800;

/** The longest silence `agentWait` will insist on. */
const AGENT_QUIET_MAX_MS = 10_000;

/** How long `agentWait` waits before answering that it is still busy. */
const AGENT_WAIT_TIMEOUT_MS = 30_000;

/** How often queued terminal output is flushed, in milliseconds (SPEC-0009, "流控"). */
const OUTPUT_FLUSH_MS = 16;

/** The most bytes one flush sends; a fast program is paced rather than allowed to fill the socket. */
const OUTPUT_FLUSH_BYTES = 64 * 1024;

/** The most output held for a terminal before the oldest is dropped. */
const OUTPUT_QUEUE_MAX = 2 * 1024 * 1024;

/** How still the screen must be before a write counts as settled (SPEC-0009, "agent 操作终端"). */
const AGENT_SETTLE_QUIET_MS = 120;

/** The longest a write waits for that. */
const AGENT_SETTLE_CAP_MS = 1500;

/** How often `agentWait` looks again. */
const AGENT_POLL_MS = 100;

/** One terminal the host is running. */
interface Running {
  terminal: Terminal;
  readonly pty: PtyProcess;
  readonly history: TerminalHistory;
  /** Where its events go now; a reconnect moves it. */
  connectionId: string;
  /** The client that owns it. */
  readonly clientId: string;
  /** Kept up to date with the PTY so an agent can read what a person would see. */
  screen: ReturnType<typeof createScreen>;
  /** When the PTY last wrote, for `agentWait`. */
  lastOutputAt: number;
  /** How many times the PTY wrote, so "quiet" can mean "quiet since we started waiting". */
  outputs: number;
  /** Recent agent writes, for the rate limit. */
  recentWrites: number[];
  /** What the program last said about itself, if it speaks OSC 7501. */
  reported: Reported | null;
  /** Whether the program has bracketed paste on, so text can be sent as one paste. */
  pasteEnabled: boolean;
  /** Output waiting to go out, and how many bytes it is; see `emitOutput`. */
  queue: string[];
  queued: number;
  /** Stops the pending flush, if one is scheduled. */
  cancelFlush: (() => void) | null;
  /** Bytes dropped since the last flush, reported once on the screen. */
  dropped: number;
  /** The tail of an escape sequence the PTY split across reads (SPEC-0009, "历史与重放"). */
  acc: string;
  /** Stops the `SIGKILL` escalation of a close under way. */
  cancelKill: (() => void) | null;
  /** Resolves the `close` that is waiting for this terminal, when it is waiting. */
  resolveClose: (() => void) | null;
  exited: boolean;
}

/**
 * The tab's name for a new terminal.
 *
 * @remarks
 * An agent's title wins, then the command's own name, then the directory's: a terminal running
 * `npm run dev` is easier to find than one named after its worktree (SPEC-0009, "目录与标题").
 *
 * @sideEffects none
 * @param input - How it was opened.
 * @param dir - Its directory.
 * @returns The title, at most 40 characters.
 */
function titleOf(input: OpenTerminalInput, dir: string): string {
  if (input.title !== undefined && input.title.trim() !== "") return input.title.trim().slice(0, 40);
  if (input.command !== undefined && input.command.trim() !== "") {
    const [first] = input.command.trim().split(/\s+/);
    return basename(first ?? "").slice(0, 40) || basename(dir);
  }
  return basename(dir) || dir;
}

/**
 * Creates the terminal service.
 *
 * @remarks
 * One PTY per terminal, owned by the host: a client attaches instead of owning the screen, which
 * is what lets a tab be rebuilt or reconnected (SPEC-0009). Output goes only to the connection
 * that opened or attached the terminal; attaching a second connection is refused by policy,
 * `terminal_not_owner`, not by the command's shape.
 *
 * @sideEffects Starts processes; emits terminal events.
 * @param options - What the service uses.
 * @returns The service.
 */
export function createTerminalService(options: TerminalServiceOptions): TerminalService {
  const running = new Map<string, Running>();
  const owners = new Map<string, string>();
  const killGraceMs = options.killGraceMs ?? 3000;

  /**
   * The running record of a terminal.
   *
   * @remarks
   * A record disappears when its process ends, so `terminal_not_found` also means "it is over".
   *
   * @sideEffects none
   * @param terminalId - The terminal.
   * @returns Its record.
   * @throws `terminal_not_found` when it is gone.
   */
  const find = (terminalId: string): Running => {
    const found = running.get(terminalId);
    if (found === undefined) throw new CommandError("terminal_not_found");
    return found;
  };

  /**
   * The record, if this connection may drive it.
   *
   * @remarks
   * Writing to a terminal somebody else is looking at would type into their screen, so ownership
   * is checked on every write and resize, not only on attach.
   *
   * @sideEffects none
   * @param caller - The connection asking, and the client behind it.
   * @param terminalId - The terminal.
   * @returns Its record.
   * @throws `terminal_not_found` or `terminal_not_owner`.
   */
  const mustOwn = (caller: Caller, terminalId: string): Running => {
    const found = find(terminalId);
    if (owners.get(terminalId) !== caller.clientId) throw new CommandError("terminal_not_owner");
    return found;
  };

  /**
   * Marks a terminal ended, once.
   *
   * @remarks
   * Both the exit event and the close path can arrive; the first one wins and releases whoever
   * is waiting in `close`.
   *
   * @sideEffects Emits `terminal_exited`, cancels the kill timer, resolves a waiting close.
   * @param entry - The terminal.
   * @param exitCode - What its process returned.
   */
  /** One close per terminal, shared by whoever asks for it (SPEC-0009, "生命周期"). */
  const closing = new Map<string, Promise<void>>();

  /**
   * Sends what a terminal wrote, at the pace a window can take.
   *
   * @remarks
   * One chunk per write would let `yes` fill the WebSocket until the server closes the whole
   * connection, chat included (SPEC-0009, "流控"). Output is queued and flushed every
   * {@link OUTPUT_FLUSH_MS} up to {@link OUTPUT_FLUSH_BYTES}; past {@link OUTPUT_QUEUE_MAX} the
   * oldest is dropped and the screen says so, which is honest and keeps the connection alive.
   *
   * @sideEffects Queues, schedules a flush, and sends.
   * @param entry - The terminal.
   * @param data - What it wrote.
   */
  const emitOutput = (entry: Running, data: string): void => {
    // A program can write megabytes in one go; splitting keeps the flush's byte budget meaningful
    // and lets the queue drop the oldest without dropping everything.
    let rest = data;
    while (rest !== "") {
      let end = Math.min(rest.length, OUTPUT_FLUSH_BYTES);
      const last = rest.charCodeAt(end - 1);
      // Never cut a surrogate pair in half.
      if (end < rest.length && last >= 0xd800 && last <= 0xdbff) end += 1;
      const piece = rest.slice(0, end);
      entry.queue.push(piece);
      entry.queued += Buffer.byteLength(piece, "utf8");
      rest = rest.slice(end);
    }
    while (entry.queued > OUTPUT_QUEUE_MAX && entry.queue.length > 1) {
      const old = entry.queue.shift();
      if (old === undefined) break;
      entry.queued -= Buffer.byteLength(old, "utf8");
      entry.dropped += Buffer.byteLength(old, "utf8");
    }
    if (entry.cancelFlush !== null) return;
    entry.cancelFlush = trackedTimeout(
      options.clock,
      options.resources,
      () => {
        entry.cancelFlush = null;
        flushOutput(entry);
      },
      OUTPUT_FLUSH_MS,
    );
  };

  /**
   * Sends one flush worth of queued output.
   *
   * @remarks
   * A drop is reported once, in the output itself, so a person looking at the screen knows why it
   * jumped; the bytes themselves are never logged.
   *
   * @sideEffects Sends `terminal_output`, and schedules the next flush while output is left.
   * @param entry - The terminal.
   */
  const flushOutput = (entry: Running): void => {
    let text = "";
    let bytes = 0;
    while (entry.queue.length > 0 && bytes < OUTPUT_FLUSH_BYTES) {
      const chunk = entry.queue.shift();
      if (chunk === undefined) break;
      bytes += Buffer.byteLength(chunk, "utf8");
      text += chunk;
    }
    entry.queued -= bytes;
    if (entry.dropped > 0) {
      options.logger.warn(
        { code: "terminal_output_dropped", terminalId: entry.terminal.id },
        "terminal output dropped",
      );
      text = `\r\n\u001b[2m[output dropped: ${String(entry.dropped)} bytes]\u001b[0m\r\n${text}`;
      entry.dropped = 0;
    }
    if (text !== "") tell(entry, { type: "terminal_output", terminalId: entry.terminal.id, data: text });
    if (entry.queue.length > 0) {
      entry.cancelFlush = trackedTimeout(
        options.clock,
        options.resources,
        () => {
          entry.cancelFlush = null;
          flushOutput(entry);
        },
        OUTPUT_FLUSH_MS,
      );
    }
  };

  /**
   * Ends a terminal once, and waits for it.
   *
   * @remarks
   * The user's tab, the agent's tool and the host's shutdown all come through here: a terminal is
   * signalled once, the escalation is cancelled when it exits, and a second ask waits for the
   * first instead of starting another (SPEC-0009, "生命周期").
   *
   * @sideEffects Signals the process group, emits `terminal_exited` and `terminal_closed`.
   * @param entry - The terminal.
   * @returns A promise that settles when the terminal is gone.
   */
  const closeEntry = (entry: Running): Promise<void> => {
    const started = closing.get(entry.terminal.id);
    if (started !== undefined) return started;
    const done = (async () => {
      if (entry.exited) {
        finish(entry);
        return;
      }
      entry.pty.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const escalation = trackedTimeout(
          options.clock,
          options.resources,
          () => {
            entry.pty.kill("SIGKILL");
          },
          killGraceMs,
        );
        // A close cannot hang the command it answers, and an unknown exit is not reported as 0.
        const giveUp = trackedTimeout(
          options.clock,
          options.resources,
          () => {
            escalation();
            settle(entry, null);
            finish(entry);
            resolve();
          },
          killGraceMs + 1000,
        );
        entry.cancelKill = () => {
          escalation();
          giveUp();
        };
        entry.resolveClose = () => {
          escalation();
          giveUp();
          resolve();
        };
      });
      // Whichever way it ended, closing is what removes the tab and the record.
      finish(entry);
    })();
    closing.set(entry.terminal.id, done);
    return done;
  };

  /**
   * Waits until the screen has settled after a write.
   *
   * @remarks
   * Settled means the program printed something since the write and then went quiet for
   * {@link AGENT_SETTLE_QUIET_MS}, or {@link AGENT_SETTLE_CAP_MS} passed. Reading straight after a
   * submit would otherwise catch a half-drawn screen (SPEC-0009, "agent 操作终端").
   *
   * @sideEffects Schedules a polling timer until it ends.
   * @param entry - The terminal.
   * @param from - Its output count when the write happened.
   * @returns Whether the screen settled.
   */
  const settleAfter = (entry: Running, from: number): Promise<boolean> =>
    new Promise((resolve) => {
      const started = options.clock.now();
      /**
       * Ends the wait once the screen is still, or the cap is reached.
       *
       * @remarks
       * A program that has printed nothing since the write is not "settled": it has not started.
       *
       * @sideEffects Resolves the promise, or schedules the next look.
       */
      const check = (): void => {
        const now = options.clock.now();
        if (entry.exited) return resolve(true);
        if (entry.outputs > from && now - entry.lastOutputAt >= AGENT_SETTLE_QUIET_MS) return resolve(true);
        if (now - started >= AGENT_SETTLE_CAP_MS) return resolve(false);
        trackedTimeout(options.clock, options.resources, check, AGENT_POLL_MS);
      };
      trackedTimeout(options.clock, options.resources, check, AGENT_POLL_MS);
    });

  /**
   * Writes to a terminal an agent owns, within the size and pace limits.
   *
   * @remarks
   * Type, key and raw all go through here, so a model cannot get around the limits by picking a
   * different tool (SPEC-0009, "agent 操作终端").
   *
   * @sideEffects Writes to the PTY.
   * @param entry - The terminal.
   * @param data - What to write.
   * @throws `terminal_write_too_large` or `terminal_write_too_fast`.
   */
  const write = (entry: Running, data: string): void => {
    if (entry.exited) throw new CommandError("terminal_not_found");
    if (Buffer.byteLength(data, "utf8") > AGENT_WRITE_MAX) {
      throw new CommandError("terminal_write_too_large");
    }
    const now = options.clock.now();
    entry.recentWrites = entry.recentWrites.filter((at) => now - at < AGENT_WRITE_WINDOW_MS);
    if (entry.recentWrites.length >= AGENT_WRITES_PER_WINDOW) {
      throw new CommandError("terminal_write_too_fast");
    }
    entry.recentWrites.push(now);
    entry.pty.write(data);
  };

  /**
   * Tells whoever should see this terminal.
   *
   * @remarks
   * A terminal the user opened belongs to one connection; one an agent opened belongs to no
   * window, so every local connection hears about it (SPEC-0009, "agent 操作终端").
   *
   * @sideEffects Sends one event.
   * @param entry - The terminal.
   * @param event - What happened.
   */
  const tell = (entry: Running, event: TerminalEvent): void => {
    if (entry.terminal.origin === "agent") options.broadcast(event);
    else options.send(entry.connectionId, event);
  };

  /**
   * The record of a terminal an agent may drive.
   *
   * @remarks
   * `terminal_not_owner` also covers a user's terminal: an agent must not read or type into the
   * one the person is using.
   *
   * @sideEffects none
   * @param sessionId - The agent's session.
   * @param terminalId - The terminal.
   * @returns Its record.
   */
  const mustOwnAgent = (sessionId: string, terminalId: string): Running => {
    const found = find(terminalId);
    if (found.terminal.origin !== "agent" || found.terminal.sessionId !== sessionId) {
      throw new CommandError("terminal_not_owner");
    }
    return found;
  };

  /**
   * Marks a terminal ended, once.
   *
   * @remarks
   * The exit event and the close path can both arrive; the first one wins and releases whoever
   * is waiting in `close`.
   *
   * @sideEffects Emits `terminal_exited`, cancels the kill timer, resolves a waiting close.
   * @param entry - The terminal.
   * @param exitCode - What its process returned.
   */
  const settle = (entry: Running, exitCode: number | null): void => {
    if (entry.exited) return;
    entry.exited = true;
    entry.cancelKill?.();
    entry.cancelKill = null;
    entry.resolveClose?.();
    entry.resolveClose = null;
    entry.terminal = { ...entry.terminal, state: "exited", exitCode };
    // -1 is "never saw it exit": a close that gave up must not report a real-looking 0.
    tell(entry, { type: "terminal_exited", terminalId: entry.terminal.id, exitCode: exitCode ?? -1 });
  };

  /**
   * Forgets a terminal and tells its connection.
   *
   * @remarks
   * The tab stays in the UI with the output it already has; only the host's record and the PTY
   * are gone (SPEC-0009, "生命周期").
   *
   * @sideEffects Emits `terminal_closed` and removes the record.
   * @param entry - The terminal.
   */
  const finish = (entry: Running): void => {
    if (!running.has(entry.terminal.id)) return;
    running.delete(entry.terminal.id);
    owners.delete(entry.terminal.id);
    tell(entry, { type: "terminal_closed", terminalId: entry.terminal.id });
  };

  /**
   * The directory a container's terminal opens in.
   *
   * @remarks
   * A chat has no directory of its own to open in, so it uses the home directory, the same rule
   * "在终端中打开" follows (SPEC-0009, "目录与标题").
   *
   * @sideEffects none
   * @param containerId - The container.
   * @returns The directory.
   * @throws `terminal_cwd_invalid` when the container is gone.
   */
  const directoryOf = (containerId: ContainerId): string => {
    if (isChatId(containerId)) return options.home;
    const dir = options.dirOf(containerId);
    if (dir === undefined) throw new CommandError("terminal_cwd_invalid");
    return dir;
  };

  return {
    open(input) {
      const dir = directoryOf(input.containerId);
      const ofContainer = [...running.values()].filter((entry) => entry.terminal.containerId === input.containerId);
      // Two budgets: the person's four, and the agents' six, counted apart so an agent cannot
      // use up the tabs someone else is working in.
      // Only running terminals count: a tab kept open after its program ended is not a slot.
      const live = ofContainer.filter((entry) => !entry.exited);
      const agents = live.filter((entry) => entry.terminal.origin === "agent").length;
      if (input.origin === "agent") {
        if (agents >= AGENT_TERMINALS_PER_CONTAINER) throw new CommandError("terminal_limit");
      } else if (live.length - agents >= TERMINAL_MAX_PER_CONTAINER) {
        throw new CommandError("terminal_limit");
      }
      const id = `term_${randomBytes(8).toString("hex")}`;
      let pty: PtyProcess;
      try {
        pty = options.spawn({
          shell: options.shell,
          cwd: dir,
          cols: input.cols,
          rows: input.rows,
          env: options.env,
        });
      } catch {
        options.logger.warn({ code: "terminal_spawn_failed" }, "terminal failed to start");
        // No cause: the message may carry paths, and the code is all a caller needs.
        throw new CommandError("terminal_spawn_failed");
      }
      const entry: Running = {
        terminal: {
          id,
          containerId: input.containerId,
          title: titleOf(input, dir),
          cwd: dir,
          cols: input.cols,
          rows: input.rows,
          state: "running",
          exitCode: null,
          origin: input.origin ?? "user",
          sessionId: input.sessionId ?? null,
        },
        pty,
        history: createHistory(),
        connectionId: input.caller.connectionId,
        clientId: input.caller.clientId,
        screen: createScreen(input.cols, input.rows),
        lastOutputAt: options.clock.now(),
        outputs: 0,
        recentWrites: [],
        reported: null,
        pasteEnabled: false,
        queue: [],
        queued: 0,
        cancelFlush: null,
        dropped: 0,
        acc: "",
        cancelKill: null,
        resolveClose: null,
        exited: false,
      };
      running.set(id, entry);
      owners.set(id, input.caller.clientId);
      pty.onData((data) => {
        // Join what the last read held back: a mode change or a query can be split anywhere.
        const { complete, rest } = splitComplete(entry.acc + data);
        entry.acc = rest;
        if (complete === "") return;
        entry.history.push(complete);
        entry.screen.write(complete);
        entry.pasteEnabled = pasteAfter(complete, entry.pasteEnabled);
        entry.reported = reportedState(complete) ?? entry.reported;
        entry.lastOutputAt = options.clock.now();
        entry.outputs += 1;
        emitOutput(entry, complete);
      });
      pty.onExit(({ exitCode }) => {
        // The record stays, with its screen and exit code, until the tab is closed: an agent's
        // last read and wait still have an answer after the program ends (SPEC-0009).
        settle(entry, exitCode);
      });
      tell(entry, {
        type: "terminal_opened",
        terminal: entry.terminal,
      } satisfies TerminalOpenedEvent);
      if (input.command !== undefined && input.command.trim() !== "") pty.write(`${input.command}\r`);
      return entry.terminal;
    },

    attach(caller, terminalId) {
      const entry = find(terminalId);
      const owner = owners.get(terminalId);
      // Attaching is a subscription; the one-connection rule is the host's, not the protocol's
      // (SPEC-0009, "给手机留的口子").
      // An agent's terminal is owned by a session, not by a window; any local window may show it.
      // A person's terminal keeps belonging to the window that opened it.
      const agentOwned = entry.terminal.origin === "agent";
      if (!agentOwned && owner !== undefined && owner !== caller.clientId) {
        throw new CommandError("terminal_not_owner");
      }
      owners.set(terminalId, caller.clientId);
      // A rebuilt tab comes back on a new socket; its output goes there from now on.
      entry.connectionId = caller.connectionId;
      return { terminal: entry.terminal, history: entry.history.text() };
    },

    write(caller, terminalId, data) {
      const entry = mustOwn(caller, terminalId);
      if (entry.exited) throw new CommandError("terminal_not_found");
      // The schema's limit counts characters; a terminal's budget is bytes, so a page of CJK pastes
      // would otherwise go through twice as large as allowed (SPEC-0009, "接口与数据").
      if (Buffer.byteLength(data, "utf8") > AGENT_WRITE_MAX) {
        throw new CommandError("terminal_write_too_large");
      }
      entry.pty.write(data);
    },

    resize(caller, terminalId, cols, rows) {
      const entry = mustOwn(caller, terminalId);
      entry.pty.resize(cols, rows);
      entry.screen.resize(cols, rows);
      entry.terminal = { ...entry.terminal, cols, rows };
    },

    async close(caller, terminalId, force) {
      // Its process already ended and the record went with it; closing the tab is then a no-op,
      // since the tab still shows the output it kept.
      const entry = running.get(terminalId);
      if (entry === undefined) return;
      if (owners.get(terminalId) !== caller.clientId) throw new CommandError("terminal_not_owner");
      // An ended terminal's tab still closes; there is nothing to signal.
      if (force !== true && (await this.hasForegroundProcess(terminalId))) {
        throw new CommandError("terminal_has_process");
      }
      await closeEntry(entry);
    },

    async agentRead(sessionId, terminalId, lines) {
      const entry = mustOwnAgent(sessionId, terminalId);
      return {
        ...(await entry.screen.read(lines)),
        state: entry.terminal.state,
        exitCode: entry.terminal.exitCode,
        reported: entry.reported,
      };
    },

    async agentType(sessionId, terminalId, text, submit) {
      const entry = mustOwnAgent(sessionId, terminalId);
      const from = entry.outputs;
      // A multi-line prompt typed as a paste stays one paste: the program does not submit at each newline.
      const body = entry.pasteEnabled ? `\u001b[200~${text}\u001b[201~` : text;
      write(entry, submit === true ? `${body}\r` : body);
      return await settleAfter(entry, from);
    },

    async agentKey(sessionId, terminalId, key) {
      const entry = mustOwnAgent(sessionId, terminalId);
      const bytes = AGENT_KEYS[key];
      // A key outside the table is a malformed request; the channel's schema refuses it first.
      if (bytes === undefined) throw new CommandError("invalid_message");
      const from = entry.outputs;
      write(entry, bytes);
      // Moving inside a menu changes little; submitting a choice redraws everything after it.
      if (key === "up" || key === "down" || key === "left" || key === "right") return true;
      return await settleAfter(entry, from);
    },

    async agentWait(sessionId, terminalId, options2 = {}) {
      const entry = mustOwnAgent(sessionId, terminalId);
      const until = options2.until ?? "quiet";
      const quietMs = Math.min(Math.max(options2.quietMs ?? AGENT_QUIET_MS, 100), AGENT_QUIET_MAX_MS);
      const timeoutMs = Math.max(options2.timeoutMs ?? AGENT_WAIT_TIMEOUT_MS, quietMs);
      const started = options.clock.now();
      // Quiet means "printed something since this wait began, then stopped": a shell prompt from
      // before the wait proves nothing, which is exactly the `mc --code` trap — the command is
      // submitted, the first screen has not arrived, and the old prompt makes it look settled.
      const from = entry.outputs;
      return new Promise((resolve) => {
        /**
         * Decides whether the wait is over.
         *
         * @remarks
         * Quiet means "the screen settled", not "the task finished": a TUI waiting for an answer
         * is quiet too (SPEC-0009, "实测 · 驱动 TUI 的三个坑").
         *
         * @sideEffects Resolves the wait, and schedules the next look when it is not over.
         */
        const check = (): void => {
          const now = options.clock.now();
          if (entry.exited) {
            resolve({ quiet: false, exited: true, exitCode: entry.terminal.exitCode });
            return;
          }
          // With `until: "exited"` silence proves nothing: only the process ending does.
          if (until === "quiet" && entry.outputs > from && now - entry.lastOutputAt >= quietMs) {
            resolve({ quiet: true, exited: false, exitCode: null });
            return;
          }
          if (now - started >= timeoutMs) {
            resolve({ quiet: false, exited: false, exitCode: null });
            return;
          }
          trackedTimeout(options.clock, options.resources, check, AGENT_POLL_MS);
        };
        trackedTimeout(options.clock, options.resources, check, AGENT_POLL_MS);
      });
    },

    async agentClose(sessionId, terminalId) {
      await closeEntry(mustOwnAgent(sessionId, terminalId));
    },

    async hasForegroundProcess(terminalId) {
      const entry = find(terminalId);
      if (entry.exited) return false;
      try {
        const children = await options.childrenOf(entry.pty.pid);
        return children.length > 0;
      } catch {
        // A failed query must not silently skip the question (SPEC-0009).
        return true;
      }
    },

    list(caller) {
      return [...running.values()]
        .filter((entry) => !entry.exited)
        .filter((entry) => entry.terminal.origin === "agent" || owners.get(entry.terminal.id) === caller.clientId)
        .map((entry) => entry.terminal);
    },

    openTerminals() {
      return [...running.values()].filter((entry) => !entry.exited).map((entry) => entry.terminal);
    },

    async closeAll() {
      // The host is going away, but a program that ignores SIGTERM still gets its SIGKILL.
      await Promise.all([...running.values()].map(async (entry) => closeEntry(entry)));
    },
  };
}
