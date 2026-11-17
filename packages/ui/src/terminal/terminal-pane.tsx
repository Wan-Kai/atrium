import type { AtriumClient } from "@atrium/client";
import "@xterm/xterm/css/xterm.css";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XTerm } from "@xterm/xterm";
import { useEffect, useRef, useState } from "react";
import { useStore } from "zustand";

/**
 * A terminal tab's screen.
 *
 * @remarks
 * The host owns the PTY; this component only attaches to it (SPEC-0009). The screen is xterm's:
 * the host's output is written straight in and keystrokes go back out, so nothing about the
 * terminal's contents is kept in React state. Output written before the attach answer arrives is
 * written after the history, in order, because the subscription is taken before attaching.
 *
 * @sideEffects Attaches to the terminal, writes to it, resizes it, and follows its output.
 * @param props - The client, the terminal, and how to start it again once it has ended.
 * @returns The terminal's screen.
 */
export function TerminalPane({
  client,
  terminalId,
  onRestart,
}: {
  readonly client: AtriumClient;
  readonly terminalId: string;
  /** Starts a fresh terminal in place of this one, once its process is gone. */
  readonly onRestart?: (() => void) | undefined;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [missing, setMissing] = useState(false);
  const terminal = useStore(client.terminals, (state) => state.terminals.find((one) => one.id === terminalId));
  const ended = terminal?.state === "exited";

  useEffect(() => {
    const element = host.current;
    if (element === null) return undefined;
    const screen = new XTerm({
      allowProposedApi: true,
      cursorBlink: true,
      fontSize: 12.5,
      fontFamily: '"SF Mono", Menlo, Monaco, monospace',
      macOptionIsMeta: true,
      scrollback: 5000,
      theme: {
        background: "#0c0c0e",
        foreground: "#d6d9de",
        cursor: "#d6d9de",
        selectionBackground: "#2f6feb66",
        black: "#17181b",
        red: "#f7768e",
        green: "#7fd88f",
        yellow: "#e0af68",
        blue: "#7aa2f7",
        magenta: "#bb9af7",
        cyan: "#7dcfff",
        white: "#d6d9de",
      },
    });
    const fit = new FitAddon();
    screen.loadAddon(fit);
    screen.open(element);
    /**
     * Fits the screen to the tab.
     *
     * @remarks
     * A tab that is hidden or has not been laid out yet has no size; it fits when it is shown.
     *
     * @sideEffects Resizes the screen.
     */
    const refit = (): void => {
      try {
        fit.fit();
      } catch {
        // A hidden tab has no size yet; it fits when it is shown.
      }
    };
    refit();
    // The tab may be laid out a frame after it mounts; fitting again then is what makes it fill.
    requestAnimationFrame(refit);
    const observer = new ResizeObserver(refit);
    observer.observe(element);
    // The history comes after the subscription, so what arrives in between is held here and
    // written after it: writing it first would show the same bytes twice, and a reply xterm gives
    // while replaying would reach the shell as typing (SPEC-0009, "历史与重放").
    let replaying = true;
    const held: string[] = [];
    const stopOutput = client.onTerminalOutput(terminalId, (data) => {
      if (replaying) held.push(data);
      else screen.write(data);
    });
    const stopInput = screen.onData((data) => {
      // Nothing typed while the screen is being replayed: the terminal is not there yet.
      if (replaying) return;
      void client.writeTerminal(terminalId, data).catch(() => undefined);
    });
    const stopResize = screen.onResize(({ cols, rows }) => {
      void client.resizeTerminal(terminalId, cols, rows).catch(() => undefined);
    });
    // Cmd/Ctrl+C copies a selection, as a terminal app does; with nothing selected it interrupts.
    screen.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown") return true;
      const copies =
        (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "c";
      const selection = screen.getSelection();
      if (copies && selection !== "") {
        void navigator.clipboard.writeText(selection).catch(() => undefined);
        screen.clearSelection();
        return false;
      }
      if (event.metaKey && event.key.toLowerCase() === "k") {
        screen.clear();
        return false;
      }
      return true;
    });
    void (async () => {
      try {
        const { terminal: attached, history } = await client.attachTerminal(terminalId);
        screen.resize(attached.cols, attached.rows);
        // Replay first, with the writer detached, and only then become live.
        screen.write(history, () => {
          replaying = false;
          for (const chunk of held.splice(0)) screen.write(chunk);
          // The attach answer can arrive before the pane has its final size.
          requestAnimationFrame(() => {
            refit();
            screen.focus();
          });
        });
      } catch {
        setMissing(true);
      }
    })();
    return () => {
      observer.disconnect();
      stopResize.dispose();
      stopInput.dispose();
      stopOutput();
      screen.dispose();
    };
  }, [client, terminalId]);

  return (
    <div className="relative flex min-h-0 w-full flex-1 flex-col overflow-hidden bg-[var(--term)]">
      <div ref={host} className="min-h-0 flex-1 px-3 py-2" />
      {missing || ended ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-[color-mix(in_srgb,var(--term)_92%,transparent)] text-[length:var(--fs-sm)] text-[var(--term-text)]">
          <span>
            {missing
              ? "这个终端已经不在运行了"
              : `终端已结束${terminal?.exitCode === null ? "" : `（退出码 ${terminal?.exitCode}）`}`}
          </span>
          {onRestart === undefined ? null : (
            <button
              type="button"
              className="rounded-[var(--r)] border border-white/15 px-3 py-1 text-[length:var(--fs-sm)] hover:bg-white/10"
              onClick={onRestart}
            >
              重新开始
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
}
