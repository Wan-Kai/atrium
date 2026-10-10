import { Copy } from "@phosphor-icons/react";
import { terminalCommand } from "../tabs/hand-off";

/**
 * What a session handed to a terminal shows instead of its transcript and input box.
 *
 * @remarks
 * SPEC-0001 ("交给终端"): the command to go on there, which can be copied again, and "在 Atrium
 * 里继续", with a reminder to quit pi in the terminal first, as two pi writing one session fork it.
 *
 * @sideEffects Writes the clipboard when asked; calls `onTakeBack` when clicked.
 * @param props - The session's file, and what taking it back does.
 * @returns The panel.
 */
export function HandedOff({ file, onTakeBack }: { readonly file: string; readonly onTakeBack: () => void }) {
  const command = terminalCommand(file);
  return (
    <section
      aria-label="已在终端中继续"
      className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-[var(--text-muted)]"
    >
      <p className="text-[20px] font-medium text-[var(--text)]">已在终端中继续</p>
      <p className="text-[length:var(--fs-meta)]">在终端里运行这条命令接着做</p>
      <div className="flex max-w-[640px] items-center gap-2 rounded-[var(--r-md)] bg-[var(--hover)] py-1.5 pr-1.5 pl-3 shadow-[inset_0_0_0_0.5px_var(--line)]">
        <code className="min-w-0 truncate font-mono text-[length:var(--fs-meta)] text-[var(--text)]">{command}</code>
        <button
          type="button"
          aria-label="复制命令"
          title="复制命令"
          className="inline-flex size-7 shrink-0 items-center justify-center rounded-[var(--r)] hover:bg-[var(--selected)]"
          onClick={() => {
            // Fire and forget: the command stays on screen to copy by hand.
            void navigator.clipboard.writeText(command).catch(() => undefined);
          }}
        >
          <Copy size={14} />
        </button>
      </div>
      <button
        type="button"
        onClick={onTakeBack}
        className="mt-2 h-9 rounded-[var(--r-btn)] px-4 text-[var(--text)] shadow-[inset_0_0_0_0.5px_var(--line)] hover:bg-[var(--selected)]"
      >
        在 Atrium 里继续
      </button>
      <p className="text-[length:var(--fs-sm)] text-[var(--text-dim)]">先退出终端里的 pi：两边同时写会让会话分叉</p>
    </section>
  );
}
