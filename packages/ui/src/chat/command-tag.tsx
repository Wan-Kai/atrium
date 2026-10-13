import type { MessageCommand } from "@atrium/protocol";
import { Sparkle } from "../design/icons";

/**
 * The tag a message that started with a command shows before its text: the command's icon and name.
 *
 * @remarks
 * Plan B of the M1.11 prototype (design-language, "命令标签"): a 22px grey pill on
 * `--surface-1` with a hairline and a faint shadow, a 14px type icon coloured as in the `/` menu
 * (a skill's sparkle in `--ctx-tools`) and the name in `--fs-meta`, 500 weight. In a bubble it
 * sits at the start, the text going on 6px after it.
 *
 * @sideEffects none
 * @param props - The command.
 * @returns The tag.
 */
export function CommandTag({ command }: { readonly command: MessageCommand }) {
  return (
    <span
      data-testid="command-tag"
      className="mr-1.5 inline-flex h-[22px] items-center gap-[5px] rounded-[var(--r-sm)] bg-[var(--surface-1)] pr-2 pl-1 align-top text-[length:var(--fs-meta)] font-medium whitespace-nowrap text-[var(--text)] shadow-[0_0_0_0.5px_var(--line-strong),0_1px_2px_rgba(0,0,0,0.05)]"
    >
      <span className="flex text-[var(--ctx-tools)]">
        <Sparkle size={14} />
      </span>
      skill:{command.name}
    </span>
  );
}
