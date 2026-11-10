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
