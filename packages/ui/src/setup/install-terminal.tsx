import { useEffect, useRef } from "react";
import { terminalLines } from "./terminal-text";

/**
 * An install job's output in a small terminal window, with a progress line under it.
 *
 * @remarks
 * SPEC-0001 ("首次启动 · 第 1 步", "设置 · pi"): while running it grows to about seven lines and
 * shows the newest; once failed it shows the whole output to scroll through. Dark in both
 * appearances (design-language, "设置"). The progress line runs while the job does, and turns
 * green or red at the end.
 *
 * @sideEffects Scrolls the output to its end as it grows while running.
 * @param props - The window's title, the job's raw output and where it is.
 * @returns The terminal.
 */
export function InstallTerminal({
  title,
  output,
  phase,
}: {
  readonly title: string;
  readonly output: string;
  readonly phase: "running" | "ok" | "failed";
}) {
  const body = useRef<HTMLDivElement>(null);
  const lines = terminalLines(output);
  // After every render: new output is what renders it again.
  useEffect(() => {
    const element = body.current;
    if (element !== null && phase === "running") element.scrollTop = element.scrollHeight;
  });
  return (
    <div
      role="log"
      aria-label={title}
      className="mt-2.5 overflow-hidden rounded-[12px] bg-[var(--term)] text-[var(--term-text)] shadow-[inset_0_0_0_0.5px_var(--term-edge),0_18px_36px_-24px_rgba(0,0,0,0.5)]"
    >
      <div className="flex h-[30px] items-center gap-1.5 border-b-[0.5px] border-white/5 px-3">
        <i className="size-2.5 rounded-full bg-[#ff5f57]" />
        <i className="size-2.5 rounded-full bg-[#febc2e]" />
        <i className="size-2.5 rounded-full bg-[#28c840]" />
        <span className="mr-10 flex-1 text-center text-[11px] text-[var(--term-dim)]">{title}</span>
      </div>
      <div
        ref={body}
        data-testid="install-output"
        className={`overflow-y-auto px-3.5 py-3 font-mono text-[11.5px] leading-[1.75] ${phase === "failed" ? "max-h-[236px]" : "max-h-[162px]"}`}
      >
        {lines.map((line, at) => (
          // Lines have no identity but their place; the output only grows.
          // oxlint-disable-next-line react/no-array-index-key
          <div key={at} className="break-all whitespace-pre-wrap">
            {line === "" ? " " : line}
          </div>
        ))}
      </div>
      <div className="h-0.5 bg-white/5">
        <i
          className={`block h-full ${
            phase === "running"
              ? "w-1/3 animate-pulse bg-[#7aaaff]"
              : phase === "ok"
                ? "w-full bg-[#4ade80]"
                : "w-full bg-[#f87171]"
          }`}
        />
      </div>
    </div>
  );
}
