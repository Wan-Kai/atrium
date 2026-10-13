import { FileText, Puzzle, Slash, Sparkle } from "../design/icons";
import type { ChosenCommand, CommandKind } from "./composer-text";

/** Each kind's icon and its colour, as the `/` list and the tags show them. */
const KIND_ICONS: Readonly<Record<CommandKind, { readonly Icon: typeof Slash; readonly color: string }>> = {
  builtin: { Icon: Slash, color: "text-[var(--tint)]" },
  extension: { Icon: Puzzle, color: "text-[var(--ok-text)]" },
  prompt: { Icon: FileText, color: "text-[var(--attn-text)]" },
  skill: { Icon: Sparkle, color: "text-[var(--ctx-tools)]" },
};

/**
 * A command kind's icon, coloured, without a ground.
 *
 * @remarks
 * design-language ("`/` 菜单"): built-in is a slash in `--tint`, extension a puzzle piece in
 * `--ok-text`, template a document in `--attn-text`, skill a sparkle in the violet of
 * `--ctx-tools`.
 *
 * @sideEffects none
 * @param props - The kind and the icon's size.
 * @returns The icon.
 */
export function CommandIcon({ source, size }: { readonly source: CommandKind; readonly size: number }) {
  const { Icon, color } = KIND_ICONS[source];
  return (
    <span data-testid="command-icon" className={`flex shrink-0 ${color}`}>
      <Icon size={size} />
    </span>
  );
}

/**
 * The tag a command shows as, at the start of the input box or of a message: its icon and name.
 *
 * @remarks
 * Plan B of the M1.11 prototype (design-language, "命令标签"): a 22px grey pill on
 * `--surface-1` with a hairline and a faint shadow, a 14px type icon coloured as in the `/` list
 * and the name, without the `/`, in `--fs-meta`, 500 weight. In a bubble it sits at the start,
 * the text going on 6px after it.
 *
 * @sideEffects none
 * @param props - The command.
 * @returns The tag.
 */
export function CommandTag({ command }: { readonly command: ChosenCommand }) {
  return (
    <span
      data-testid="command-tag"
      className="mr-1.5 inline-flex h-[22px] items-center gap-[5px] rounded-[var(--r-sm)] bg-[var(--surface-1)] pr-2 pl-1 align-top text-[length:var(--fs-meta)] font-medium whitespace-nowrap text-[var(--text)] shadow-[0_0_0_0.5px_var(--line-strong),0_1px_2px_rgba(0,0,0,0.05)]"
    >
      <CommandIcon source={command.source} size={14} />
      {command.name}
    </span>
  );
}
