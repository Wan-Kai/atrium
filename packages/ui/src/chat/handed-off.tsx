import { Copy } from "../design/icons";
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

/**
 * What an archived direction's session shows instead of its input box.
 *
 * @remarks
 * SPEC-0008 ("ML1 定的细节"), design-language ("学习模式"): the session is only read, from its
 * file, as its directory moved under `Archive/`; "恢复" moves it back so it can go on.
 *
 * @sideEffects none; calls `onRestore` when clicked.
 * @param props - What restoring does.
 * @returns The bar.
 */
export function ArchivedDirectionBar({ onRestore }: { readonly onRestore: () => void }) {
  return (
    <section
      aria-label="方向已归档"
      className="mx-auto flex w-full max-w-[var(--column)] items-center gap-3 px-6 pt-2 pb-5 text-[length:var(--fs-meta)] text-[var(--text-muted)]"
    >
      <span className="min-w-0 flex-1">这个方向已归档，恢复以后才能接着学</span>
      <button
        type="button"
        onClick={onRestore}
        className="h-[30px] shrink-0 rounded-[var(--r-btn)] px-3 text-[var(--tint)] shadow-[inset_0_0_0_0.5px_var(--line-strong)] hover:bg-[var(--hover)]"
      >
        恢复
      </button>
    </section>
  );
}
