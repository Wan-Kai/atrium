import {
  Add01Icon,
  AddCircleIcon,
  AddSquareIcon,
  Alert02Icon,
  AlertCircleIcon,
  ArrowDown01Icon,
  ArrowDown02Icon,
  ArrowExpandIcon,
  ArrowRight01Icon,
  ArrowRight02Icon,
  ArrowShrinkIcon,
  ArrowUp01Icon,
  ArrowUp02Icon,
  ArrowUpRight01Icon,
  AtIcon,
  Cancel01Icon,
  CheckmarkCircle02Icon,
  Clock02Icon,
  Coins01Icon,
  CommandLineIcon,
  ComputerIcon,
  ComputerTerminal01Icon,
  Copy01Icon,
  CornerDownRightIcon,
  DashboardSpeed02Icon,
  DatabaseIcon,
  Download04Icon,
  File01Icon,
  File02Icon,
  FlashIcon,
  FolderAddIcon,
  Folder01Icon,
  FolderOpenIcon,
  FoldVerticalIcon,
  GitBranchIcon,
  GitCompareIcon,
  GitMergeIcon,
  HelpCircleIcon,
  Image01Icon,
  InformationCircleIcon,
  Key01Icon,
  Loading03Icon,
  MinusSignSquareIcon,
  Moon02Icon,
  MoreHorizontalIcon,
  PaintBoardIcon,
  PencilEdit01Icon,
  RefreshIcon,
  ReloadIcon,
  Search01Icon,
  Settings01Icon,
  SquareIcon,
  StopCircleIcon,
  Sun03Icon,
  TextAlignLeftIcon,
  Tick02Icon,
  UserIcon,
  ViewIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import type { SVGProps } from "react";

/** Props of every icon: its size, how heavy it is drawn, and the SVG's own attributes. */
interface IconProps extends Omit<SVGProps<SVGSVGElement>, "ref" | "strokeWidth"> {
  /** Width and height; `1em` when not given, so it follows the text. */
  readonly size?: number | string;
  /** `bold` thickens the line (ticks, arrows, "more"); `fill` fills the shape (stop, a changed file's dot). */
  readonly weight?: "regular" | "bold" | "fill";
}

/** The line width of every icon on its 24 grid, about 1px on screen at 14px (design-language, "图标"). */
const STROKE = 1.75;

/** The line width of a `bold` icon, unless the icon has its own. */
const BOLD = 2.25;

/**
 * Makes an icon component from Hugeicons' drawing.
 *
 * @remarks
 * The UI takes icons from this module only, so the set and its line widths are chosen in one place
 * (design-language, "图标"). The components keep the names they had when the UI drew with Phosphor,
 * which describe the shape each place asked for.
 *
 * @sideEffects none
 * @param drawing - The icon's elements.
 * @param bold - Its line width when `bold`.
 * @returns The component.
 */
function drawn(drawing: IconSvgElement, bold = BOLD) {
  /**
   * Draws the icon.
   *
   * @remarks
   * See {@link drawn}. A `fill` icon keeps its outline and fills inside it.
   *
   * @sideEffects none
   * @param props - The size, weight and SVG attributes.
   * @returns The SVG.
   */
  function Icon({ size = "1em", weight = "regular", ...rest }: IconProps) {
    return (
      <HugeiconsIcon
        icon={drawing}
        size={size}
        strokeWidth={weight === "bold" ? bold : STROKE}
        {...(weight === "fill" ? { fill: "currentColor" } : {})}
        {...rest}
      />
    );
  }
  return Icon;
}

/** A dot in the middle of the grid, as a changed file's mark; Hugeicons' circle fills the whole grid. */
const DOT: IconSvgElement = [["circle", { cx: "12", cy: "12", r: "4.5", stroke: "currentColor", key: "0" }]];

/**
 * Meta's mark, from Tabler Icons' `brand-meta` (MIT, https://tabler.io/icons), which Hugeicons' free
 * set draws unlike Meta's; same 24 grid, round caps and joins.
 */
const META: IconSvgElement = [
  [
    "path",
    {
      d: "M12 10.174Q14.649 5.999 16.648 6c2 0 3.263 2.213 4 5.217c.704 2.869.5 6.783-2 6.783c-1.114 0-2.648-1.565-4.148-3.652a27.6 27.6 0 0 1-2.5-4.174m0 0Q9.351 5.999 7.352 6c-2 0-3.263 2.213-4 5.217c-.704 2.869-.5 6.783 2 6.783C6.466 18 8 16.435 9.5 14.348q1.5-2.087 2.5-4.174",
      stroke: "currentColor",
      strokeLinecap: "round",
      strokeLinejoin: "round",
      key: "0",
    },
  ],
];

export const ArrowBendDownRight = drawn(CornerDownRightIcon);
export const ArrowClockwise = drawn(ReloadIcon);
export const ArrowDown = drawn(ArrowDown02Icon);
export const ArrowRight = drawn(ArrowRight02Icon);
export const ArrowsClockwise = drawn(RefreshIcon);
export const ArrowsInLineVertical = drawn(FoldVerticalIcon);
export const ArrowsInSimple = drawn(ArrowShrinkIcon);
export const ArrowsOutSimple = drawn(ArrowExpandIcon);
export const ArrowUp = drawn(ArrowUp02Icon, 2.5);
export const ArrowUpRight = drawn(ArrowUpRight01Icon);
export const At = drawn(AtIcon);
export const CaretDown = drawn(ArrowDown01Icon);
export const CaretRight = drawn(ArrowRight01Icon);
export const CaretUp = drawn(ArrowUp01Icon);
export const Check = drawn(Tick02Icon);
export const CheckCircle = drawn(CheckmarkCircle02Icon);
export const CircleNotch = drawn(Loading03Icon);
export const ClockCounterClockwise = drawn(Clock02Icon);
export const Coins = drawn(Coins01Icon);
export const Copy = drawn(Copy01Icon);
export const Database = drawn(DatabaseIcon);
export const DotOutline = drawn(DOT);
export const DotsThree = drawn(MoreHorizontalIcon, 2.5);
export const DownloadSimple = drawn(Download04Icon);
export const Eye = drawn(ViewIcon);
export const File = drawn(File01Icon);
export const FileText = drawn(File02Icon);
export const Folder = drawn(Folder01Icon);
export const FolderOpen = drawn(FolderOpenIcon);
export const FolderPlus = drawn(FolderAddIcon);
export const Gauge = drawn(DashboardSpeed02Icon);
export const GearSix = drawn(Settings01Icon);
export const GitBranch = drawn(GitBranchIcon);
export const GitDiff = drawn(GitCompareIcon);
export const GitMerge = drawn(GitMergeIcon);
export const ImageIcon = drawn(Image01Icon);
export const Info = drawn(InformationCircleIcon);
export const Key = drawn(Key01Icon);
export const Lightning = drawn(FlashIcon);
export const MagnifyingGlass = drawn(Search01Icon);
export const MetaLogo = drawn(META);
export const MinusSquare = drawn(MinusSignSquareIcon);
export const Monitor = drawn(ComputerIcon);
export const Moon = drawn(Moon02Icon);
export const Palette = drawn(PaintBoardIcon);
export const PencilSimple = drawn(PencilEdit01Icon);
export const Plus = drawn(Add01Icon);
export const PlusCircle = drawn(AddCircleIcon);
export const PlusSquare = drawn(AddSquareIcon);
export const Question = drawn(HelpCircleIcon);
export const Square = drawn(SquareIcon);
export const Stop = drawn(StopCircleIcon);
export const Sun = drawn(Sun03Icon);
export const Terminal = drawn(CommandLineIcon);
export const TerminalWindow = drawn(ComputerTerminal01Icon);
export const TextAlignLeft = drawn(TextAlignLeftIcon);
export const User = drawn(UserIcon);
export const Warning = drawn(Alert02Icon);
export const WarningCircle = drawn(AlertCircleIcon);
export const X = drawn(Cancel01Icon);
