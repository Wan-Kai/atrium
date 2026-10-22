import {
  Add01Icon,
  AddSquareIcon,
  Alert02Icon,
  AlertCircleIcon,
  ArrowDown01Icon,
  ArrowDown02Icon,
  ArrowExpandIcon,
  ArrowRight01Icon,
  ArrowRight02Icon,
  ArrowShrinkIcon,
  ArrowTurnBackwardIcon,
  ArrowUp01Icon,
  ArrowUp02Icon,
  ArrowUpRight01Icon,
  AtIcon,
  BubbleChatAddIcon,
  Cancel01Icon,
  CheckmarkCircle02Icon,
  Clock01Icon,
  Clock02Icon,
  Coins01Icon,
  CommandLineIcon,
  ComputerIcon,
  ComputerTerminal01Icon,
  Copy01Icon,
  CornerDownRightIcon,
  DashboardSpeed02Icon,
  DatabaseIcon,
  Delete02Icon,
  Download04Icon,
  File01Icon,
  File02Icon,
  FileDiffIcon,
  Files01Icon,
  FlashIcon,
  FlowchartIcon,
  Folder01Icon,
  FolderAddIcon,
  FoldVerticalIcon,
  GitBranchIcon,
  GitCommitIcon,
  GitCompareIcon,
  GitForkIcon,
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
  PuzzleIcon,
  RefreshIcon,
  ReloadIcon,
  Robot01Icon,
  Search01Icon,
  SearchAddIcon,
  SearchMinusIcon,
  Settings01Icon,
  SidebarLeftIcon,
  SidebarRightIcon,
  SlashIcon,
  SourceCodeIcon,
  SparklesIcon,
  SquareIcon,
  StopCircleIcon,
  Sun03Icon,
  TextAlignLeftIcon,
  TextWrapIcon,
  Tick02Icon,
  UnfoldVerticalIcon,
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

/**
 * An open folder, from Tabler Icons' `folder-open` (MIT, https://tabler.io/icons); Hugeicons' free
 * `folder-open` carries a curled arrow that reads as a smudge at 15px. Same 24 grid, round caps and joins.
 */
const FOLDER_OPEN: IconSvgElement = [
  [
    "path",
    {
      d: "M5 19l2.757-7.351a1 1 0 0 1 .936-.649h12.307a1 1 0 0 1 .986 1.164l-.996 5.211a2 2 0 0 1-1.964 1.625h-14.026a2 2 0 0 1-2-2v-11a2 2 0 0 1 2-2h4l3 3h7a2 2 0 0 1 2 2v2",
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
export const ArrowTurnBack = drawn(ArrowTurnBackwardIcon);
export const ArrowsInLineVertical = drawn(FoldVerticalIcon);
export const ArrowsOutLineVertical = drawn(UnfoldVerticalIcon);
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
export const Code = drawn(SourceCodeIcon);
export const Clock = drawn(Clock01Icon);
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
export const FileDiff = drawn(FileDiffIcon);
export const Files = drawn(Files01Icon);
export const Flowchart = drawn(FlowchartIcon);
export const Folder = drawn(Folder01Icon);
export const FolderOpen = drawn(FOLDER_OPEN);
export const FolderPlus = drawn(FolderAddIcon);
export const Gauge = drawn(DashboardSpeed02Icon);
export const GearSix = drawn(Settings01Icon);
export const GitBranch = drawn(GitBranchIcon);
export const GitCommit = drawn(GitCommitIcon);
export const GitDiff = drawn(GitCompareIcon);
export const GitFork = drawn(GitForkIcon);
export const GitMerge = drawn(GitMergeIcon);
export const ImageIcon = drawn(Image01Icon);
export const Info = drawn(InformationCircleIcon);
export const Key = drawn(Key01Icon);
export const Lightning = drawn(FlashIcon);
export const MagnifyingGlass = drawn(Search01Icon);
export const MagnifyingGlassMinus = drawn(SearchMinusIcon);
export const MagnifyingGlassPlus = drawn(SearchAddIcon);
export const MetaLogo = drawn(META);
export const MinusSquare = drawn(MinusSignSquareIcon);
export const Monitor = drawn(ComputerIcon);
export const Moon = drawn(Moon02Icon);
export const Palette = drawn(PaintBoardIcon);
export const PencilSimple = drawn(PencilEdit01Icon);
export const Plus = drawn(Add01Icon);
export const Trash = drawn(Delete02Icon);
export const ChatAdd = drawn(BubbleChatAddIcon);
export const PlusSquare = drawn(AddSquareIcon);
export const Question = drawn(HelpCircleIcon);
export const Puzzle = drawn(PuzzleIcon);
export const Robot = drawn(Robot01Icon);
export const SidebarLeft = drawn(SidebarLeftIcon);
export const SidebarRight = drawn(SidebarRightIcon);
export const Slash = drawn(SlashIcon);
export const Sparkle = drawn(SparklesIcon);
export const Square = drawn(SquareIcon);
export const Stop = drawn(StopCircleIcon);
export const Sun = drawn(Sun03Icon);
export const Terminal = drawn(CommandLineIcon);
export const TerminalWindow = drawn(ComputerTerminal01Icon);
export const TextAlignLeft = drawn(TextAlignLeftIcon);
export const TextWrap = drawn(TextWrapIcon);
export const User = drawn(UserIcon);
export const Warning = drawn(Alert02Icon);
export const WarningCircle = drawn(AlertCircleIcon);
export const X = drawn(Cancel01Icon);
