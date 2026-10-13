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
  BashIcon,
  Cancel01Icon,
  CheckmarkCircle02Icon,
  Clock02Icon,
  Coins01Icon,
  CommandLineIcon,
  ComputerIcon,
  ComputerTerminal01Icon,
  Copy01Icon,
  CornerDownRightIcon,
  CppIcon,
  Css3Icon,
  CsvIcon,
  DartIcon,
  DashboardSpeed02Icon,
  DatabaseIcon,
  Download04Icon,
  File01Icon,
  File02Icon,
  FileBracesIcon,
  FileImageIcon,
  FileLockIcon,
  FileZipIcon,
  FlashIcon,
  Folder01Icon,
  FolderAddIcon,
  FolderOpenIcon,
  FoldVerticalIcon,
  GitBranchIcon,
  GitCommitIcon,
  GitCompareIcon,
  GitMergeIcon,
  HelpCircleIcon,
  Html5Icon,
  Image01Icon,
  InformationCircleIcon,
  JavaIcon,
  JavaScriptIcon,
  Key01Icon,
  Loading03Icon,
  MinusSignSquareIcon,
  Moon02Icon,
  MoreHorizontalIcon,
  NpmIcon,
  PaintBoardIcon,
  PdfIcon,
  PencilEdit01Icon,
  PhpIcon,
  PythonIcon,
  ReactIcon,
  RefreshIcon,
  ReloadIcon,
  Search01Icon,
  Settings01Icon,
  SqlIcon,
  SquareIcon,
  StopCircleIcon,
  Sun03Icon,
  SvgIcon,
  TextAlignLeftIcon,
  Tick02Icon,
  TxtIcon,
  TypescriptIcon,
  UserIcon,
  ViewIcon,
  XmlIcon,
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
 * A drawing made of Tabler Icons' paths (MIT, https://tabler.io/icons).
 *
 * @remarks
 * For marks Hugeicons' free set lacks; same 24 grid, round caps and joins (design-language, "图标").
 *
 * @sideEffects none
 * @param paths - The paths' `d`.
 * @returns The drawing.
 */
function tabler(...paths: readonly string[]): IconSvgElement {
  return paths.map((d, index) => [
    "path",
    { d, stroke: "currentColor", strokeLinecap: "round", strokeLinejoin: "round", key: String(index) },
  ]);
}

/** Tabler's `markdown`. */
const MARKDOWN = tabler(
  "M3 7a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2v10a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-10",
  "M7 15v-6l2 2l2 -2v6",
  "M14 13l2 2l2 -2m-2 2v-6",
);

/** Tabler's `brand-rust`. */
const RUST = tabler(
  "M10.139 3.463c.473 -1.95 3.249 -1.95 3.722 0a1.916 1.916 0 0 0 2.859 1.185c1.714 -1.045 3.678 .918 2.633 2.633a1.916 1.916 0 0 0 1.184 2.858c1.95 .473 1.95 3.249 0 3.722a1.916 1.916 0 0 0 -1.185 2.859c1.045 1.714 -.918 3.678 -2.633 2.633a1.916 1.916 0 0 0 -2.858 1.184c-.473 1.95 -3.249 1.95 -3.722 0a1.916 1.916 0 0 0 -2.859 -1.185c-1.714 1.045 -3.678 -.918 -2.633 -2.633a1.916 1.916 0 0 0 -1.184 -2.858c-1.95 -.473 -1.95 -3.249 0 -3.722a1.916 1.916 0 0 0 1.185 -2.859c-1.045 -1.714 .918 -3.678 2.633 -2.633a1.914 1.914 0 0 0 2.858 -1.184",
  "M8 12h6a2 2 0 1 0 0 -4h-6v8v-4",
  "M19 16h-2a2 2 0 0 1 -2 -2a2 2 0 0 0 -2 -2h-1",
  "M9 8h-4",
  "M5 16h4",
);

/** Tabler's `brand-golang`. */
const GOLANG = tabler(
  "M15.695 14.305c1.061 1.06 2.953 .888 4.226 -.384c1.272 -1.273 1.444 -3.165 .384 -4.226c-1.061 -1.06 -2.953 -.888 -4.226 .384c-1.272 1.273 -1.444 3.165 -.384 4.226",
  "M12.68 9.233c-1.084 -.497 -2.545 -.191 -3.591 .846c-1.284 1.273 -1.457 3.165 -.388 4.226c1.07 1.06 2.978 .888 4.261 -.384a3.669 3.669 0 0 0 1.038 -1.921h-2.427",
  "M5.5 15h-1.5",
  "M6 9h-2",
  "M5 12h-3",
);

/** Tabler's `brand-docker`. */
const DOCKER = tabler(
  "M22 12.54c-1.804 -.345 -2.701 -1.08 -3.523 -2.94c-.487 .696 -1.102 1.568 -.92 2.4c.028 .238 -.32 1 -.557 1h-14c0 5.208 3.164 7 6.196 7c4.124 .022 7.828 -1.376 9.854 -5c1.146 -.101 2.296 -1.505 2.95 -2.46",
  "M5 10h3v3h-3l0 -3",
  "M8 10h3v3h-3l0 -3",
  "M11 10h3v3h-3l0 -3",
  "M8 7h3v3h-3l0 -3",
  "M11 7h3v3h-3l0 -3",
  "M11 4h3v3h-3l0 -3",
  "M4.571 18c1.5 0 2.047 -.074 2.958 -.78",
  "M10 16l0 .01",
);

/** Tabler's `brand-vue`. */
const VUE = tabler("M16.5 4l-4.5 8l-4.5 -8", "M3 4l9 16l9 -16");

/** Tabler's `brand-swift`. */
const SWIFT = tabler(
  "M20.547 15.828c1.33 -4.126 -1.384 -9.521 -6.047 -12.828c-.135 -.096 2.39 6.704 1.308 9.124c-2.153 -1.454 -4.756 -3.494 -7.808 -6.124l-.5 2l-3.5 -1c4.36 4.748 7.213 7.695 8.56 8.841c-4.658 2.089 -10.65 -.978 -10.56 -.841c1.016 1.545 6 6 11 6c2 0 3.788 -.502 4.742 -1.389c.005 -.005 .432 -.446 1.378 -.17c.504 .148 1.463 .667 2.88 1.559v-1.507c0 -1.377 -.515 -2.67 -1.453 -3.665",
);

/** Tabler's `brand-kotlin`. */
const KOTLIN = tabler("M20 20h-16v-16h16", "M4 20l16 -16", "M4 12l8 -8", "M12 12l8 8");

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
export const GitCommit = drawn(GitCommitIcon);
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

/** File type marks, for file chips (design-language, "文件胶囊"). */
export const FileMarks = {
  ts: drawn(TypescriptIcon),
  react: drawn(ReactIcon),
  js: drawn(JavaScriptIcon),
  npm: drawn(NpmIcon),
  json: drawn(FileBracesIcon),
  md: drawn(MARKDOWN),
  css: drawn(Css3Icon),
  html: drawn(Html5Icon),
  py: drawn(PythonIcon),
  rs: drawn(RUST),
  go: drawn(GOLANG),
  sh: drawn(BashIcon),
  java: drawn(JavaIcon),
  kotlin: drawn(KOTLIN),
  swift: drawn(SWIFT),
  php: drawn(PhpIcon),
  dart: drawn(DartIcon),
  c: drawn(CppIcon),
  vue: drawn(VUE),
  docker: drawn(DOCKER),
  sql: drawn(SqlIcon),
  image: drawn(FileImageIcon),
  svg: drawn(SvgIcon),
  pdf: drawn(PdfIcon),
  csv: drawn(CsvIcon),
  xml: drawn(XmlIcon),
  git: drawn(GitBranchIcon),
  lock: drawn(FileLockIcon),
  config: drawn(Settings01Icon),
  text: drawn(TxtIcon),
  archive: drawn(FileZipIcon),
  file: drawn(File01Icon),
} as const;
