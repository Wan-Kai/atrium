import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import type { MathPlugin } from "@streamdown/math";
import type { DiagramPlugin } from "@streamdown/mermaid";
import { type ComponentProps, useEffect, useMemo, useReducer } from "react";
import { type Components, type PluginConfig, Streamdown, defaultRemarkPlugins } from "streamdown";
import { useDarkMode } from "../design/use-dark-mode";
import { normalizeMathDelimiters, remarkHtmlAsText } from "./markdown-transforms";

/** Streamdown's default Markdown plugins, plus showing raw HTML as text. */
const REMARK_PLUGINS = [...Object.values(defaultRemarkPlugins), remarkHtmlAsText];

/** Math needs loading once a reply contains `$$` or `\(`. */
const NEEDS_MATH = /\$\$|\\\(/;
/** Mermaid needs loading once a reply contains a mermaid code block. */
const NEEDS_MERMAID = /^ {0,3}(?:`{3,}|~{3,})\s*mermaid/m;

/** Plugins loaded so far, shared by every reply. */
const loaded: { math?: MathPlugin; mermaid?: DiagramPlugin } = {};
let mathLoading: Promise<unknown> | undefined;
let mermaidLoading: Promise<unknown> | undefined;

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
      ...(loaded.mermaid === undefined ? {} : { mermaid: loaded.mermaid }),
    }),
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- `version` stands for the module-level `loaded`.
    [version],
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
 * desktop shell already sends links to the system browser.
 *
 * @sideEffects May load the math or Mermaid plugin.
 * @param props - The text and whether it is still streaming.
 * @returns The rendered Markdown.
 */
export function Markdown({ text, streaming }: MarkdownProps) {
  const plugins = usePlugins(text);
  const dark = useDarkMode();
  const mermaid = useMemo(() => ({ config: { theme: dark ? ("dark" as const) : ("default" as const) } }), [dark]);
  return (
    <Streamdown
      plugins={plugins}
      remarkPlugins={REMARK_PLUGINS}
      components={COMPONENTS}
      mermaid={mermaid}
      isAnimating={streaming}
      className="atrium-markdown"
    >
      {normalizeMathDelimiters(text)}
    </Streamdown>
  );
}
