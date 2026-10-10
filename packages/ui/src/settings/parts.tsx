import { Check } from "@phosphor-icons/react";
import type { ReactNode } from "react";

/** A pill button (design-language, "设置"). */
export const BUTTON =
  "inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[var(--r-pill)] px-3 text-[length:var(--fs-meta)] text-[var(--text-2)] shadow-[inset_0_0_0_0.5px_var(--line-strong)] hover:bg-[var(--selected)] hover:text-[var(--text)] disabled:cursor-not-allowed disabled:opacity-45";

/** The one button a block leads with. */
export const PRIMARY_BUTTON =
  "inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[var(--r-pill)] bg-[var(--text)] px-3 text-[length:var(--fs-meta)] font-medium text-[var(--main)] shadow-[0_1px_2px_rgba(0,0,0,0.12)] hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-45";

/** A button without a frame, for "取消", "退出" and the like. */
export const GHOST_BUTTON =
  "inline-flex h-6 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[var(--r-pill)] px-2 text-[length:var(--fs-sm)] text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text-2)] disabled:cursor-not-allowed disabled:opacity-45";

/** A link-like button. */
export const LINK_BUTTON = "text-[length:var(--fs-sm)] text-[var(--tint)] hover:underline disabled:opacity-45";

/** A text field. */
export const FIELD =
  "h-[30px] min-w-0 rounded-[var(--r)] bg-[var(--hover)] px-2.5 text-[length:var(--fs-meta)] text-[var(--text)] shadow-[inset_0_0_0_0.5px_var(--line-strong)] outline-none placeholder:text-[var(--text-dim)] focus:shadow-[inset_0_0_0_0.5px_var(--line-strong),var(--focus-ring)]";

/**
 * A group of settings: a heading, a line on what it is for, its rows and a note under them.
 *
 * @remarks
 * The settings panel's unit (design-language, "设置"). The heading names the group for assistive
 * technology.
 *
 * @sideEffects none
 * @param props - The heading, the lines above and below, and the rows.
 * @returns The group.
 */
export function Group({
  title,
  description,
  footer,
  children,
}: {
  readonly title?: string;
  readonly description?: ReactNode;
  readonly footer?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <section aria-label={title} className="mb-[30px]">
      {title === undefined ? null : (
        <h4 className="mb-0.5 text-[length:var(--fs-meta)] font-semibold text-[var(--text)]">{title}</h4>
      )}
      {description === undefined ? null : (
        <p className="mb-2.5 text-[length:var(--fs-sm)] leading-[1.55] text-[var(--text-muted)]">{description}</p>
      )}
      <div className="-mx-3">{children}</div>
      {footer === undefined ? null : (
        <p className="mt-2.5 text-[length:var(--fs-sm)] leading-[1.55] text-[var(--text-dim)]">{footer}</p>
      )}
    </section>
  );
}

/**
 * One setting: what it is, a line under it, and its controls on the right.
 *
 * @remarks
 * Rows of a group are split by a thin line; a busy row, such as a login under way, is outlined in
 * the tint instead (design-language, "线与交互态").
 *
 * @sideEffects none
 * @param props - What leads the row, its label and detail, whether it is busy or a compact
 * key–value row, its controls, and what shows under it.
 * @returns The row.
 */
export function Row({
  lead,
  label,
  detail,
  busy = false,
  compact = false,
  controls,
  children,
}: {
  readonly lead?: ReactNode;
  readonly label: ReactNode;
  readonly detail?: ReactNode;
  readonly busy?: boolean;
  readonly compact?: boolean;
  readonly controls?: ReactNode;
  readonly children?: ReactNode;
}) {
  return (
    <div
      className={`relative rounded-[var(--r-md)] px-3 [&+&]:before:absolute [&+&]:before:inset-x-3 [&+&]:before:top-0 [&+&]:before:h-[0.5px] [&+&]:before:bg-[var(--line)] ${
        compact ? "py-2" : "py-2.5"
      } ${busy ? "bg-[var(--linked)] shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--tint)_60%,transparent)] before:hidden" : ""}`}
    >
      <div className={`flex items-center gap-3 ${compact ? "min-h-6" : "min-h-8"}`}>
        {lead}
        <div className="min-w-0 flex-1">
          <div
            className={
              compact
                ? "text-[length:var(--fs-meta)] text-[var(--text-2)]"
                : "text-[length:var(--fs)] font-medium text-[var(--text)]"
            }
          >
            {label}
          </div>
          {detail === undefined ? null : (
            <div className="mt-px text-[length:var(--fs-sm)] leading-normal text-[var(--text-muted)]">{detail}</div>
          )}
        </div>
        <div
          className={`flex shrink-0 items-center gap-2 text-[length:var(--fs-sm)] ${busy ? "text-[var(--tint)]" : "text-[var(--text-muted)]"}`}
        >
          {controls}
        </div>
      </div>
      {children}
    </div>
  );
}

/**
 * A small spinning ring, for something under way.
 *
 * @remarks
 * In the colour of the text around it.
 *
 * @sideEffects none
 * @returns The ring.
 */
export function Spinner() {
  return (
    <span
      aria-hidden
      className="inline-block size-3 shrink-0 animate-spin rounded-full border-[1.5px] border-current border-r-transparent"
    />
  );
}

/**
 * A provider's icon on its white tile.
 *
 * @remarks
 * Official icons sit on a white rounded tile in both appearances (design-language, "图标"); a
 * provider without one shows the generic icon given.
 *
 * @sideEffects none
 * @param props - The icon's address, whether it fills the tile, its name, and what to show
 * without an icon.
 * @returns The tile.
 */
export function BrandTile({
  logo,
  fills,
  name,
  fallback,
}: {
  readonly logo: string | null;
  readonly fills: boolean;
  readonly name: string;
  readonly fallback: ReactNode;
}) {
  return (
    <span className="grid size-8 shrink-0 place-items-center overflow-hidden rounded-[9px] bg-white text-[#0866ff] shadow-[0_0_0_0.5px_rgba(0,0,0,0.08),0_1px_3px_rgba(0,0,0,0.06)]">
      {logo === null ? fallback : <img src={logo} alt={name} className={fills ? "size-8" : "size-5"} />}
    </span>
  );
}

/**
 * The tick beside the chosen item of a menu.
 *
 * @remarks
 * Keeps its width when not shown, so the items line up.
 *
 * @sideEffects none
 * @param props - Whether it shows.
 * @returns The tick.
 */
export function Tick({ on }: { readonly on: boolean }) {
  return (
    <span className="inline-flex w-3.5 shrink-0 text-[var(--tint)]">
      {on ? <Check size={12} weight="bold" /> : null}
    </span>
  );
}

/**
 * pi's mark on its white tile.
 *
 * @remarks
 * pi's official mark (pi.dev), drawn inline so it needs no file.
 *
 * @sideEffects none
 * @returns The tile.
 */
export function PiMark() {
  return (
    <span className="grid size-8 shrink-0 place-items-center rounded-[9px] bg-white shadow-[0_0_0_0.5px_rgba(0,0,0,0.08),0_1px_3px_rgba(0,0,0,0.06)]">
      <svg viewBox="150 150 500 500" role="img" aria-label="pi" className="size-[22px]">
        <path fill="#F09082" d="M165.29 165.29H517.36V400H400V282.65H165.29Z" />
        <path fill="#4D9ABF" d="M165.29 282.65H282.65V400H400V517.36H282.65V634.72H165.29Z" />
        <path fill="#F1BE58" d="M517.36 400H634.72V634.72H517.36Z" />
      </svg>
    </span>
  );
}
