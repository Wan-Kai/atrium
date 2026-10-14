import type { CSSProperties } from "react";

/** A run of text and its colours in the light and dark appearances; `null` is the text's own. */
export type Token = readonly [text: string, light: string | null, dark: string | null];

/** A text's lines of tokens. */
export type TokenLines = readonly (readonly Token[])[];

/** What the highlighting worker is asked: some texts of one file, by its path. */
export interface HighlightRequest {
  readonly id: number;
  readonly path: string;
  readonly texts: readonly string[];
}

/** What it answers: each text's lines, or `null` for a language it does not know or a failure. */
export interface HighlightReply {
  readonly id: number;
  readonly texts: readonly TokenLines[] | null;
}

let worker: Worker | null = null;
let next = 0;
const waiting = new Map<number, (texts: readonly TokenLines[] | null) => void>();

/**
 * The page's highlighting worker, started on first use.
 *
 * @remarks
 * One for the page, kept for its life, as Shiki's grammars are worth keeping loaded. Should it
 * fail, every text waiting goes without colours.
 *
 * @sideEffects Starts the worker the first time.
 * @returns The worker.
 */
function highlighter(): Worker {
  if (worker !== null) return worker;
  const started = new Worker(new URL("./highlight.worker.ts", import.meta.url), { type: "module" });
  started.addEventListener("message", (event: MessageEvent<HighlightReply>) => {
    waiting.get(event.data.id)?.(event.data.texts);
    waiting.delete(event.data.id);
  });
  started.addEventListener("error", () => {
    for (const settle of waiting.values()) settle(null);
    waiting.clear();
  });
  worker = started;
  return started;
}

/**
 * Colours texts of a file, off the page's thread.
 *
 * @remarks
 * SPEC-0001 ("M1.12 的文件与更改 · 查看标签"): as the file's language, by its name (`languageOf`).
 * Several texts go at once, as a diff's hunk sides do, to save the trips.
 *
 * @sideEffects Starts the worker the first time; posts it the texts.
 * @param path - The file's path, for its language.
 * @param texts - The texts, each without a last line break.
 * @returns Each text's lines of tokens, or `null` when the language is not known or it failed.
 */
export function highlight(path: string, texts: readonly string[]): Promise<readonly TokenLines[] | null> {
  const id = next++;
  return new Promise((settle) => {
    waiting.set(id, settle);
    const request: HighlightRequest = { id, path, texts };
    highlighter().postMessage(request);
  });
}

/**
 * A token's colours as a style: CSS picks the appearance's (`.code-tokens` in `styles.css`).
 *
 * @remarks
 * A colour left out lets the line's own show, as a deleted line's dimmer one.
 *
 * @sideEffects none
 * @param token - The token.
 * @returns The style, or `undefined` for a token in the text's own colour.
 */
export function tokenStyle([, light, dark]: Token): CSSProperties | undefined {
  if (light === null && dark === null) return undefined;
  const style: Record<`--${string}`, string> = {};
  if (light !== null) style["--l"] = light;
  if (dark !== null) style["--d"] = dark;
  return style;
}
