import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import type { MathPlugin } from "@streamdown/math";
import type { DiagramPlugin } from "@streamdown/mermaid";
import { type ComponentProps, useEffect, useMemo, useReducer, useState } from "react";
import {
  CodeBlock,
  CodeBlockCopyButton,
  type Components,
  type ControlsConfig,
  type CustomRendererProps,
  type IconMap,
  type MermaidOptions,
  type PluginConfig,
  Streamdown,
  type StreamdownTranslations,
  defaultRemarkPlugins,
} from "streamdown";
import {
  ArrowClockwise,
  ArrowUpRight,
  ArrowsOutSimple,
  Check,
  CircleNotch,
  Code,
  Copy,
  DownloadSimple,
  Flowchart,
  MagnifyingGlassMinus,
  MagnifyingGlassPlus,
  X,
} from "../design/icons";
import { useDarkMode } from "../design/use-dark-mode";
import { normalizeMathDelimiters, remarkHtmlAsText } from "./markdown-transforms";

/** Streamdown's default Markdown plugins, plus showing raw HTML as text. */
const REMARK_PLUGINS = [...Object.values(defaultRemarkPlugins), remarkHtmlAsText];

/** Math needs loading once a reply contains `$$` or `\(`. */
const NEEDS_MATH = /\$\$|\\\(/;
/** Mermaid needs loading once a reply contains a mermaid code block. */
const NEEDS_MERMAID = /^ {0,3}(?:`{3,}|~{3,})\s*mermaid/m;

/**
 * The buttons a block offers: copying code; copying a table and seeing it larger; for Mermaid, only
 * seeing it larger, as `MermaidBlock` adds the rest. Nothing downloads, and diagrams pan and zoom only
 * when larger (design-language, "消息流").
 */
const CONTROLS: ControlsConfig = {
  code: { copy: true, download: false },
  table: { copy: true, download: false, fullscreen: true },
  mermaid: { copy: false, download: false, fullscreen: true, panZoom: false },
  image: false,
};

/** Streamdown's buttons drawn with Atrium's icons (design-language, "图标"). */
const ICONS: Partial<IconMap> = {
  CheckIcon: Check,
  CopyIcon: Copy,
  DownloadIcon: DownloadSimple,
  ExternalLinkIcon: ArrowUpRight,
  Loader2Icon: CircleNotch,
  Maximize2Icon: ArrowsOutSimple,
  RotateCcwIcon: ArrowClockwise,
  XIcon: X,
  ZoomInIcon: MagnifyingGlassPlus,
  ZoomOutIcon: MagnifyingGlassMinus,
};

/** How tall a table grows before it scrolls inside, in pixels. */
const TABLE_MAX_HEIGHT = 640;

/** Streamdown's words, in Chinese. */
const TRANSLATIONS: Partial<StreamdownTranslations> = {
  close: "关闭",
  copied: "已复制",
  copyCode: "复制",
  copyLink: "复制链接",
  copyTable: "复制表格",
  copyTableAsCsv: "复制为 CSV",
  copyTableAsMarkdown: "复制为 Markdown",
  copyTableAsTsv: "复制为 TSV",
  exitFullscreen: "还原",
  imageNotAvailable: "图片无法显示",
  openExternalLink: "打开链接",
  openLink: "打开链接",
  resetView: "复原",
  viewFullscreen: "放大",
  zoomIn: "拉近",
  zoomOut: "拉远",
};

/** Plugins loaded so far, shared by every reply. */
const loaded: { math?: MathPlugin; mermaid?: DiagramPlugin } = {};
let mathLoading: Promise<unknown> | undefined;
let mermaidLoading: Promise<unknown> | undefined;
/** What `MermaidBlock` draws its diagram with: just the Mermaid plugin, once loaded, kept as one object. */
let drawing: PluginConfig = {};

/**
 * Loads the math plugin and KaTeX's styles, once.
 *
 * @remarks
 * KaTeX is large and most replies have no formulas, so it loads the first time one does
 * (SPEC-0001, "回复渲染").
 *
 * @sideEffects Imports the plugin and a stylesheet.
 * @returns Resolves once loaded.
 */
function loadMath(): Promise<unknown> {
  mathLoading ??= Promise.all([import("@streamdown/math"), import("katex/dist/katex.min.css")]).then(([module]) => {
    loaded.math = module.math;
    return loaded.math;
  });
  return mathLoading;
}

/**
 * Loads the Mermaid plugin, once.
 *
 * @remarks
 * Mermaid is the largest dependency of all; it loads the first time a reply draws a diagram.
 *
 * @sideEffects Imports the plugin.
 * @returns Resolves once loaded.
 */
function loadMermaid(): Promise<unknown> {
  mermaidLoading ??= import("@streamdown/mermaid").then((module) => {
    loaded.mermaid = module.mermaid;
    drawing = { mermaid: module.mermaid };
    return loaded.mermaid;
  });
  return mermaidLoading;
}

/**
 * The renderer plugins a text needs, loading heavy ones on first use.
 *
 * @remarks
 * The returned object keeps its identity until a plugin finishes loading, because Streamdown
 * re-renders everything when its plugins change. Until math or Mermaid has loaded, the text
 * shows as written and then re-renders once.
 *
 * @sideEffects May import plugins; re-renders the component when one arrives.
 * @param text - The Markdown.
 * @returns The plugin configuration.
 */
function usePlugins(text: string): PluginConfig {
  const [version, loadedOne] = useReducer((count: number) => count + 1, 0);
  const needsMath = NEEDS_MATH.test(text);
  const needsMermaid = NEEDS_MERMAID.test(text);
  useEffect(() => {
    let active = true;
    /**
     * Re-renders once a plugin arrives, unless the component has gone.
     *
     * @remarks
     * The plugin is cached for every reply; this component just needs to render again.
     *
     * @sideEffects Re-renders the component.
     */
    const arrived = (): void => {
      if (active) loadedOne();
    };
    // Fire and forget: a plugin that fails to load leaves the text as written.
    if (needsMath && loaded.math === undefined) loadMath().then(arrived, () => undefined);
    if (needsMermaid && loaded.mermaid === undefined) loadMermaid().then(arrived, () => undefined);
    return () => {
      active = false;
    };
  }, [needsMath, needsMermaid]);
  // `version` changes exactly when a plugin was loaded.
  return useMemo(
    () => ({
      code,
      cjk,
      ...(loaded.math === undefined ? {} : { math: loaded.math }),
      ...(loaded.mermaid === undefined ? {} : { renderers: [{ language: "mermaid", component: MermaidBlock }] }),
    }),
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- `version` stands for the module-level `loaded`.
    [version],
  );
}

/**
 * The colours Mermaid draws with, read from the design tokens in the current appearance.
 *
 * @remarks
 * Mermaid takes colours as values, not CSS variables, and works out its other colours from them; nodes
 * are neutral rather than its default purple (design-language, "消息流").
 *
 * @sideEffects Reads the computed style of `<html>`.
 * @param dark - Whether the page is dark, which Mermaid needs told.
 * @returns Mermaid's options.
 */
function mermaidOptions(dark: boolean): MermaidOptions {
  const tokens = getComputedStyle(document.documentElement);
  /**
   * Reads one design token.
   *
   * @remarks
   * See {@link mermaidOptions}.
   *
   * @sideEffects none
   * @param name - The custom property.
   * @returns Its value.
   */
  const token = (name: string): string => tokens.getPropertyValue(name).trim();
  return {
    config: {
      theme: "base",
      darkMode: dark,
      fontFamily: token("--font-sans"),
      themeVariables: {
        darkMode: dark,
        background: token("--code"),
        primaryColor: token("--main"),
        primaryBorderColor: token("--line-strong"),
        primaryTextColor: token("--text-2"),
        secondaryColor: token("--surface-2"),
        tertiaryColor: token("--surface-2"),
        lineColor: token("--text-dim"),
        textColor: token("--text-2"),
        edgeLabelBackground: token("--code"),
        fontFamily: token("--font-sans"),
        fontSize: "13px",
      },
    },
  };
}

/**
 * Fences Mermaid source as a code block, with more backticks than any run inside it.
 *
 * @remarks
 * `MermaidBlock` hands the source back to Streamdown to draw, so the fence must not end early.
 *
 * @sideEffects none
 * @param source - The source.
 * @returns The Markdown.
 */
function mermaidFence(source: string): string {
  const longest = Math.max(2, ...(source.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  return `${fence}mermaid\n${source}\n${fence}`;
}

/**
 * A Mermaid block: the diagram, or its source at a click.
 *
 * @remarks
 * SPEC-0001 ("回复渲染") asks to switch to the source, which Streamdown's own block cannot, so this
 * renderer takes Mermaid blocks over. The diagram is still Streamdown's, in a Markdown holding just
 * this block, with its zoom; the source is Streamdown's code block. Its switch and copy buttons sit
 * before the zoom button (design-language, "消息流"). A block still being written shows as source:
 * half a diagram cannot be drawn.
 *
 * @sideEffects Renders the diagram with the Mermaid plugin; copying writes the clipboard.
 * @param props - The block's source and whether it is still being written.
 * @returns The block.
 */
function MermaidBlock({ code: source, isIncomplete }: CustomRendererProps) {
  const [showingSource, showSource] = useState(false);
  const dark = useDarkMode();
  const options = useMemo(() => mermaidOptions(dark), [dark]);
  if (isIncomplete) {
    return (
      <CodeBlock code={source} language="mermaid" isIncomplete lineNumbers={false}>
        <CodeBlockCopyButton />
      </CodeBlock>
    );
  }
  const label = showingSource ? "看图" : "看源码";
  return (
    <div className="atrium-mermaid">
      <div className="atrium-block-actions">
        <button type="button" aria-label={label} title={label} onClick={() => showSource(!showingSource)}>
          {showingSource ? <Flowchart size={14} aria-hidden /> : <Code size={14} aria-hidden />}
        </button>
        <CodeBlockCopyButton code={source} />
      </div>
      {showingSource ? (
        <CodeBlock code={source} language="mermaid" lineNumbers={false} />
      ) : (
        <Streamdown
          plugins={drawing}
          mermaid={options}
          controls={CONTROLS}
          icons={ICONS}
          translations={TRANSLATIONS}
          lineNumbers={false}
        >
          {mermaidFence(source)}
        </Streamdown>
      )}
    </div>
  );
}

/**
 * A link in a reply, opened in the system browser.
 *
 * @remarks
 * A new window is refused by the desktop shell, which hands `http` and `https` addresses to the
 * system browser instead (security.md, "Electron"); the page itself never navigates.
 *
 * @sideEffects none
 * @param props - The anchor's props from the renderer.
 * @returns The link.
 */
function ExternalLink({ node: _node, ...props }: ComponentProps<"a"> & { node?: unknown }) {
  return (
    <a {...props} target="_blank" rel="noopener noreferrer" className="text-tint underline-offset-2 hover:underline" />
  );
}

/**
 * An image in a reply.
 *
 * @remarks
 * Local and `https` images show directly; an `http` image is not loaded and shows as a link to
 * it (SPEC-0001, "回复渲染"; security.md, "渲染内容"), which the page's CSP enforces anyway.
 *
 * @sideEffects none
 * @param props - The image's props from the renderer.
 * @returns The image, or a link for an `http` address.
 */
function ReplyImage({ node: _node, src, alt, ...props }: ComponentProps<"img"> & { node?: unknown }) {
  if (typeof src === "string" && /^http:/i.test(src)) {
    return <ExternalLink href={src}>{alt === undefined || alt === "" ? src : alt}</ExternalLink>;
  }
  return <img {...props} src={src} alt={alt} loading="lazy" className="max-w-full rounded-[var(--r-md)]" />;
}

const COMPONENTS: Components = { a: ExternalLink, img: ReplyImage };

/** Props of {@link Markdown}. */
export interface MarkdownProps {
  /** The Markdown as received so far. */
  readonly text: string;
  /** Whether more text may still arrive; unfinished syntax is completed while it does. */
  readonly streaming: boolean;
}

/**
 * Renders a reply or reasoning as Markdown.
 *
 * @remarks
 * Streamdown completes unfinished syntax while text streams and keeps finished blocks from
 * re-rendering (SPEC-0001, "回复渲染"). The configuration follows the SPEC: GFM, Shiki
 * highlighting and Mermaid themes following light and dark, CJK punctuation next to emphasis,
 * `$$…$$` and `\(…\)` math but not single dollars, links to the system browser, raw HTML shown as
 * text. Links use `ExternalLink`, so Streamdown's own link confirmation never applies; the
 * desktop shell already sends links to the system browser. Code blocks have no line numbers and no
 * download, buttons are Atrium's icons with Chinese names, and `styles.css` lays the blocks flat
 * (design-language, "消息流"); Mermaid blocks go to `MermaidBlock` once its plugin has loaded.
 *
 * @sideEffects May load the math or Mermaid plugin.
 * @param props - The text and whether it is still streaming.
 * @returns The rendered Markdown.
 */
export function Markdown({ text, streaming }: MarkdownProps) {
  const plugins = usePlugins(text);
  return (
    <Streamdown
      plugins={plugins}
      remarkPlugins={REMARK_PLUGINS}
      components={COMPONENTS}
      controls={CONTROLS}
      icons={ICONS}
      translations={TRANSLATIONS}
      lineNumbers={false}
      // Streamdown's 300px scrolled a table after ten rows (design-language, "代码块、表格、Mermaid 图").
      tableMaxHeight={TABLE_MAX_HEIGHT}
      isAnimating={streaming}
      // space-y-3 replaces Streamdown's own space-y-4: blocks 12px apart (design-language, "字体").
      className="atrium-markdown space-y-3"
    >
      {normalizeMathDelimiters(text)}
    </Streamdown>
  );
}
