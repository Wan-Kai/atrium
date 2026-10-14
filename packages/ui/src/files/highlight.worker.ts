import { type HighlighterCore, createHighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { bundledLanguages, bundledLanguagesInfo } from "shiki/langs";
import { bundledThemes } from "shiki/themes";
import type { HighlightReply, HighlightRequest, Token } from "./highlight";
import { languageOf } from "./languages";

// Colours code off the page's thread, as the viewer tabs ask (SPEC-0001, "M1.12 的文件与更改 ·
// 查看标签"; design-language, "查看标签"): Shiki's github-light and github-dark, with its
// JavaScript regex engine, as the page's policy allows no WebAssembly. Languages load as needed.

/** The themes, by appearance. */
const THEMES = { light: "github-light", dark: "github-dark" } as const;

/** Each language's loader, by id. */
const LOADERS = new Map(Object.entries(bundledLanguages));

let core: Promise<HighlighterCore> | null = null;

/**
 * The highlighter, made on first use.
 *
 * @remarks
 * `forgiving`, as the chat's code blocks: a pattern the engine cannot run matches nothing rather
 * than failing the file.
 *
 * @sideEffects Loads the themes the first time.
 * @returns The highlighter.
 */
function highlighter(): Promise<HighlighterCore> {
  core ??= createHighlighterCore({
    themes: [bundledThemes[THEMES.light], bundledThemes[THEMES.dark]],
    langs: [],
    engine: createJavaScriptRegexEngine({ forgiving: true }),
  });
  return core;
}

/**
 * A colour, or `null` where it is the theme's own text colour.
 *
 * @remarks
 * The page colours such text itself, as a deleted line is dimmer (design-language, "查看标签").
 *
 * @sideEffects none
 * @param color - The token's colour.
 * @param plain - The theme's text colour.
 * @returns The colour, or `null`.
 */
function colourOf(color: string | undefined, plain: string): string | null {
  return color === undefined || color.toLowerCase() === plain.toLowerCase() ? null : color;
}

/**
 * Colours each text as the file's language.
 *
 * @remarks
 * `null` when the language is not known.
 *
 * @sideEffects Loads the highlighter and the language as needed.
 * @param request - The file's path and the texts.
 * @returns Each text's lines of tokens, or `null`.
 */
async function colour(request: HighlightRequest): Promise<HighlightReply["texts"]> {
  const language = languageOf(request.path, bundledLanguagesInfo);
  const loader = language === null ? undefined : LOADERS.get(language);
  if (language === null || loader === undefined) return null;
  const shiki = await highlighter();
  await shiki.loadLanguage(loader);
  const plain = { light: shiki.getTheme(THEMES.light).fg, dark: shiki.getTheme(THEMES.dark).fg };
  return request.texts.map((text) =>
    shiki
      .codeToTokensWithThemes(text, { lang: language, themes: THEMES })
      .map((line) =>
        line.map((token): Token => [
          token.content,
          colourOf(token.variants["light"]?.color, plain.light),
          colourOf(token.variants["dark"]?.color, plain.dark),
        ]),
      ),
  );
}

self.addEventListener("message", (event: MessageEvent<HighlightRequest>) => {
  const request = event.data;
  /**
   * Answers the request.
   *
   * @remarks
   * A failure answers `null`, so the text shows uncoloured.
   *
   * @sideEffects Posts the reply.
   * @param texts - The tokens, or `null`.
   */
  const reply = (texts: HighlightReply["texts"]): void => {
    const answer: HighlightReply = { id: request.id, texts };
    self.postMessage(answer);
  };
  colour(request).then(reply, () => reply(null));
});
