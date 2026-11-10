import { Archive } from "../design/icons";

/**
 * What a session archived in a direction still there shows instead of its input box.
 *
 * @remarks
 * SPEC-0008 ("ML3 定的细节 · 方向里归档了的会话"), prototype 5B's shared screen: the session was
 * archived with its level and is only read, from its file; opening it does not put it back. A
 * 44px `--code` band, the archive icon, "这个会话已归档，恢复以后才能接着发" and "恢复", which puts it
 * back with its children.
 *
 * @sideEffects none; calls `onRestore` when clicked.
 * @param props - What restoring does.
 * @returns The bar.
 */
export function ArchivedSessionBar({ onRestore }: { readonly onRestore: () => void }) {
  return (
    <section aria-label="会话已归档" className="mx-auto w-full max-w-[var(--column)] px-6 pt-2 pb-5">
      <div className="flex h-11 items-center gap-2 rounded-[14px] bg-[var(--code)] px-3.5 text-[length:var(--fs-meta)] text-[var(--text-muted)]">
        <Archive size={14} aria-hidden className="shrink-0" />
        <span className="min-w-0 flex-1 truncate">这个会话已归档，恢复以后才能接着发</span>
        <button
          type="button"
          onClick={onRestore}
          className="h-[26px] shrink-0 rounded-[9px] px-2.5 text-[length:var(--fs-sm)] font-medium text-[var(--tint)] shadow-[inset_0_0_0_1px_var(--tint)] hover:bg-[var(--linked)]"
        >
          恢复
        </button>
      </div>
    </section>
  );
}
