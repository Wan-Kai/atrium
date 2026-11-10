import type { HomeDots } from "./home-view";
import type { StripDot } from "./progress";

/**
 * One dot of a level's steps.
 *
 * @remarks
 * design-language "常驻步骤条" and prototype 2D: lessons square, the steps after round; done
 * `--text-muted`, current `--tint`, not done `--line-strong`; the current one of an archived
 * direction or a later version's file a grey ring, a finished one's all lit. 8px on the strip and
 * the continue card, 6px on a direction's card (prototype study-home 2A, ML4).
 *
 * @sideEffects none
 * @param props - The dot, how it is drawn, and its size.
 * @returns The dot.
 */
function Dot({
  dot,
  look,
  small,
}: {
  readonly dot: StripDot;
  readonly look: "learning" | "archived" | "finished" | "newer";
  readonly small: boolean;
}) {
  const shape = dot.round ? "rounded-full" : small ? "rounded-[1.5px]" : "rounded-[2px]";
  const fill =
    look === "finished"
      ? "bg-[var(--tint)]"
      : dot.state === "done"
        ? "bg-[var(--text-muted)]"
        : dot.state === "current"
          ? look === "archived" || look === "newer"
            ? "shadow-[inset_0_0_0_1.5px_var(--text-muted)]"
            : "bg-[var(--tint)]"
          : "bg-[var(--line-strong)]";
  return <i data-state={dot.state} className={`block ${small ? "size-1.5" : "size-2"} ${shape} ${fill}`} />;
}

/**
 * A level's dots, as the step strip, a direction's card and the continue card draw them.
 *
 * @remarks
 * One part for all three (SPEC-0008, "ML4 定的细节 · 方向卡片"), 3px apart; a broken file's are
 * hollow placeholders (prototype 2D). Read as "共 N 步".
 *
 * @sideEffects none
 * @param props - The dots and whether they are the card's small ones.
 * @returns The dots.
 */
export function StepDots({ dots, small = false }: { readonly dots: HomeDots; readonly small?: boolean }) {
  const size = small ? "size-1.5 rounded-[1.5px]" : "size-2 rounded-[2px]";
  if (dots.kind === "broken") {
    return (
      <span className="inline-flex gap-[3px]" aria-hidden>
        {Array.from({ length: dots.count }, (_, at) => (
          <i key={at} className={`block ${size} shadow-[inset_0_0_0_1px_var(--line-strong)]`} />
        ))}
      </span>
    );
  }
  return (
    <span className="inline-flex gap-[3px]" role="img" aria-label={`共 ${String(dots.dots.length)} 步`}>
      {dots.dots.map((dot) => (
        <Dot key={dot.id} dot={dot} look={dots.look} small={small} />
      ))}
    </span>
  );
}
