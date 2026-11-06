import {
  Add01Icon,
  Alert02Icon,
  ArrowDown01Icon,
  ArrowDown02Icon,
  ArrowExpandIcon,
  ArrowLeft01Icon,
  ArrowLeft02Icon,
  ArrowRight01Icon,
  ArrowRight02Icon,
  ArrowShrinkIcon,
  ArrowTurnBackwardIcon,
  ArrowUp01Icon,
  ArrowUp02Icon,
  Bug01Icon,
  Cancel01Icon,
  CancelCircleIcon,
  ChartBarLineIcon,
  ChartLineData01Icon,
  CheckmarkCircle02Icon,
  Clock01Icon,
  CloudIcon,
  ComputerIcon,
  ComputerTerminal01Icon,
  Copy01Icon,
  CpuIcon,
  DatabaseIcon,
  Delete02Icon,
  FavouriteIcon,
  File01Icon,
  Flag01Icon,
  FlashIcon,
  Folder01Icon,
  GitBranchIcon,
  GitCommitIcon,
  GitMergeIcon,
  GlobeIcon,
  GridIcon,
  HelpCircleIcon,
  InformationCircleIcon,
  Key01Icon,
  Layers01Icon,
  Link01Icon,
  MinusSignIcon,
  NextIcon,
  PauseIcon,
  PieChartIcon,
  PlayIcon,
  PreviousIcon,
  RefreshIcon,
  Search01Icon,
  ServerStack01Icon,
  Settings01Icon,
  ShuffleIcon,
  Sorting01Icon,
  SourceCodeIcon,
  SparklesIcon,
  SquareLock01Icon,
  SquareUnlock01Icon,
  StarIcon,
  StopIcon,
  Tick02Icon,
  UserIcon,
  ViewIcon,
} from "@hugeicons/core-free-icons";
import { VISUAL_CDN_HOSTS, VISUAL_ICONS, type VisualIcon } from "@atrium/pi";

/** One drawing of Hugeicons: its elements, each a tag and its attributes. */
type Drawing = readonly (readonly [string, Readonly<Record<string, string | number>>])[];

/** Each offered icon's drawing; the record type makes a missing name fail to compile. */
const DRAWINGS: Readonly<Record<VisualIcon, Drawing>> = {
  play: PlayIcon,
  pause: PauseIcon,
  stop: StopIcon,
  next: NextIcon,
  previous: PreviousIcon,
  refresh: RefreshIcon,
  reset: ArrowTurnBackwardIcon,
  "chevron-left": ArrowLeft01Icon,
  "chevron-right": ArrowRight01Icon,
  "chevron-up": ArrowUp01Icon,
  "chevron-down": ArrowDown01Icon,
  "arrow-left": ArrowLeft02Icon,
  "arrow-right": ArrowRight02Icon,
  "arrow-up": ArrowUp02Icon,
  "arrow-down": ArrowDown02Icon,
  check: Tick02Icon,
  close: Cancel01Icon,
  "check-circle": CheckmarkCircle02Icon,
  "cancel-circle": CancelCircleIcon,
  plus: Add01Icon,
  minus: MinusSignIcon,
  info: InformationCircleIcon,
  alert: Alert02Icon,
  help: HelpCircleIcon,
  search: Search01Icon,
  settings: Settings01Icon,
  clock: Clock01Icon,
  database: DatabaseIcon,
  file: File01Icon,
  folder: Folder01Icon,
  lock: SquareLock01Icon,
  unlock: SquareUnlock01Icon,
  user: UserIcon,
  server: ServerStack01Icon,
  computer: ComputerIcon,
  cloud: CloudIcon,
  "git-branch": GitBranchIcon,
  "git-commit": GitCommitIcon,
  "git-merge": GitMergeIcon,
  flash: FlashIcon,
  key: Key01Icon,
  eye: ViewIcon,
  code: SourceCodeIcon,
  terminal: ComputerTerminal01Icon,
  sparkles: SparklesIcon,
  shuffle: ShuffleIcon,
  sort: Sorting01Icon,
  expand: ArrowExpandIcon,
  shrink: ArrowShrinkIcon,
  bug: Bug01Icon,
  layers: Layers01Icon,
  link: Link01Icon,
  globe: GlobeIcon,
  flag: Flag01Icon,
  star: StarIcon,
  heart: FavouriteIcon,
  delete: Delete02Icon,
  copy: Copy01Icon,
  cpu: CpuIcon,
  "chart-line": ChartLineData01Icon,
  "chart-bar": ChartBarLineIcon,
  "pie-chart": PieChartIcon,
  grid: GridIcon,
};

/** The line width of every icon on its 24 grid, as Atrium draws its own (design-language, "图标"). */
const STROKE = "1.75";

/** The CDN sites, as CSP sources. */
const CDN = VISUAL_CDN_HOSTS.join(" ");

/**
 * The Content Security Policy a visual is served with (SPEC-0007, "沙箱").
 *
 * @remarks
 * As the SPEC writes it, from `default-src 'none'`, without `'unsafe-eval'`; `sandbox allow-scripts`
 * keeps the page an opaque origin even when its address is opened on its own, outside the iframe
 * (security.md, "渲染内容"). The desktop shell sets the same policy on `atrium-visual:` responses.
 */
export const VISUAL_CSP = [
  "default-src 'none'",
  `script-src 'unsafe-inline' ${CDN} atrium-visual:`,
  `style-src 'unsafe-inline' ${CDN} atrium-visual:`,
  `img-src data: blob: ${CDN}`,
  `font-src data: ${CDN} atrium-visual:`,
  "media-src data: blob:",
  "worker-src blob:",
  "connect-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "sandbox allow-scripts",
].join("; ");

/**
 * Escapes text for an HTML attribute value in double quotes.
 *
 * @remarks
 * Hugeicons' values are path data and keywords, but nothing is put in markup unescaped.
 *
 * @sideEffects none
 * @param value - The value.
 * @returns It escaped.
 */
function attribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}

/**
 * Whether a name is one of the offered icons.
 *
 * @remarks
 * Own keys only, so `constructor` and the like are no icons.
 *
 * @sideEffects none
 * @param name - The name.
 * @returns Whether it is offered.
 */
function isOffered(name: string): name is VisualIcon {
  return Object.hasOwn(DRAWINGS, name);
}

/**
 * An offered icon as SVG markup, or nothing for a name not offered.
 *
 * @remarks
 * SPEC-0007 ("运行环境"): a name outside the list shows as empty. React's camel-case attribute names
 * become SVG's, `key` is React's own, and every stroke is drawn at Atrium's width. No `xmlns`: the
 * markup goes into an HTML page, where it is not needed.
 *
 * @sideEffects none
 * @param name - The name a fragment wrote.
 * @returns The SVG, or an empty string.
 */
export function iconSvg(name: string): string {
  const drawing = isOffered(name) ? DRAWINGS[name] : undefined;
  if (drawing === undefined) return "";
  const parts = drawing.map(([tag, attributes]) => {
    const written = Object.entries(attributes)
      .filter(([key]) => key !== "key")
      .map(([key, value]) => {
        const svgName = key.replaceAll(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`);
        return `${svgName}="${attribute(svgName === "stroke-width" ? STROKE : String(value))}"`;
      });
    return `<${tag} ${written.join(" ")}></${tag}>`;
  });
  return `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" aria-hidden="true">${parts.join("")}</svg>`;
}

/**
 * JSON safe to put inside an inline script.
 *
 * @remarks
 * `<` is escaped so no `</script>` or `<!--` can end or bend the script early.
 *
 * @sideEffects none
 * @param value - Any JSON value.
 * @returns The JSON.
 */
function scriptJson(value: unknown): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

/**
 * The script the frame runs before the fragment: theme, icons, height, activity and the bridge.
 *
 * @remarks
 * SPEC-0007 ("运行环境", "回传") and its MV1 details: messages follow MCP Apps' JSON-RPC. The page
 * stays hidden until the theme arrives, at most 300 ms. `<i data-icon>` is drawn as the parser or
 * a script adds it. Height is the document's, reported on every change. Activity is reported at
 * most every 200 ms, for the card's snapshot. `window.atrium.sendMessage` checks that the user just
 * clicked; the page in the app checks again, since a fragment shares this script's realm and could
 * post on its own.
 * Before anything else it takes every WebRTC constructor (`RTC*`, `webkitRTC*`) off the frame's
 * global for good, as `undefined` that can be neither deleted nor redefined: WebRTC reaches the
 * network past the CSP and the app's request filter, TURN over TCP even past the window's UDP
 * policy (security.md, 2026-11-06).
 *
 * @sideEffects none
 * @returns The script's text.
 */
function bridgeScript(): string {
  const icons = Object.fromEntries(VISUAL_ICONS.map((name) => [name, iconSvg(name)]));
  return `(() => {
  for (const name of Object.getOwnPropertyNames(window)) {
    if (/^(?:webkit)?RTC/u.test(name)) {
      Object.defineProperty(window, name, { value: undefined, writable: false, enumerable: false, configurable: false });
    }
  }
  const icons = ${scriptJson(icons)};
  const root = document.documentElement;
  root.setAttribute("data-atrium-waiting", "");
  const reveal = () => root.removeAttribute("data-atrium-waiting");
  setTimeout(reveal, 300);
  const post = (message) => parent.postMessage(message, "*");
  const pending = new Map();
  let nextId = 1;
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      post({ jsonrpc: "2.0", id, method, params });
    });
  const apply = (context) => {
    const variables = (context && context.styles && context.styles.variables) || {};
    for (const [name, value] of Object.entries(variables)) {
      if (/^--[a-z0-9-]+$/.test(name) && typeof value === "string") root.style.setProperty(name, value);
    }
    if (context && (context.theme === "light" || context.theme === "dark")) {
      root.style.colorScheme = context.theme;
      root.dataset.theme = context.theme;
    }
    reveal();
  };
  addEventListener("message", (event) => {
    if (event.source !== parent) return;
    const data = event.data;
    if (data === null || typeof data !== "object" || data.jsonrpc !== "2.0") return;
    if (data.id !== undefined && pending.has(data.id)) {
      const waiting = pending.get(data.id);
      pending.delete(data.id);
      if (data.error) waiting.reject(new Error(String(data.error.message)));
      else waiting.resolve(data.result);
    } else if (data.method === "ui/notifications/host-context-changed") apply(data.params);
  });
  request("ui/initialize", { appInfo: { name: "atrium-visual", version: "1" }, appCapabilities: {} }).then(
    (result) => apply(result && result.hostContext),
    reveal,
  );
  const draw = (element) => {
    element.innerHTML = icons[element.getAttribute("data-icon")] || "";
    element.setAttribute("aria-hidden", "true");
  };
  const sweep = (node) => {
    if (node.nodeType !== 1) return;
    if (node.matches("i[data-icon]")) draw(node);
    for (const element of node.querySelectorAll("i[data-icon]")) draw(element);
  };
  new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === "attributes") draw(record.target);
      else for (const node of record.addedNodes) sweep(node);
    }
  }).observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-icon"] });
  let height = -1;
  const measure = () => {
    const next = Math.ceil(root.getBoundingClientRect().height);
    if (next === height) return;
    height = next;
    post({ jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height } });
  };
  const sizes = new ResizeObserver(measure);
  sizes.observe(root);
  addEventListener("DOMContentLoaded", () => sizes.observe(document.body));
  let quietUntil = 0;
  const active = () => {
    const now = Date.now();
    if (now < quietUntil) return;
    quietUntil = now + 200;
    post({ jsonrpc: "2.0", method: "atrium/notifications/activity" });
  };
  for (const type of ["pointerdown", "pointermove", "keydown", "wheel", "input"]) addEventListener(type, active, true);
  const atrium = Object.freeze({
    sendMessage(text) {
      if (typeof text !== "string" || text === "" || text.length > 4000) return Promise.resolve(false);
      if (!navigator.userActivation || !navigator.userActivation.isActive) return Promise.resolve(false);
      return request("ui/message", { role: "user", content: { type: "text", text } }).then(() => true, () => false);
    },
  });
  Object.defineProperty(window, "atrium", { value: atrium, writable: false, configurable: false });
})();`;
}

/** The frame's styles: Atrium's font and size, its surface, icons the size of the text. */
const FRAME_STYLE = `:root { color-scheme: light dark; }
html { height: auto; }
html[data-atrium-waiting] body { visibility: hidden; }
body {
  margin: 0;
  background: var(--surface-1, Canvas);
  color: var(--text, CanvasText);
  font-family: var(--font-sans, -apple-system, sans-serif);
  font-size: var(--fs, 14px);
  line-height: 1.5;
}
i[data-icon] { display: inline-flex; width: 1em; height: 1em; vertical-align: -0.125em; }
i[data-icon] svg { width: 100%; height: 100%; stroke: currentColor; }`;

/**
 * The page a visual is served as: the frame, then the fragment unchanged.
 *
 * @remarks
 * SPEC-0007 ("运行环境"): the fragment has no `<html>`, `<head>` or `<body>` of its own; the frame
 * supplies them, its styles and its script, which runs first so the bridge and icons are there
 * before any of the fragment's scripts.
 *
 * @sideEffects none
 * @param fragment - The visual file's text.
 * @returns The page's HTML.
 */
export function visualPage(fragment: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>${FRAME_STYLE}</style><script>${bridgeScript()}</script></head><body>${fragment}</body></html>`;
}
