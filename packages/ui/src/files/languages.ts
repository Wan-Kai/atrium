/** A language Shiki knows: its id and the other names it goes by. */
export interface LanguageInfo {
  readonly id: string;
  readonly aliases?: readonly string[];
}

/** Whole file names that say the language, where the extension does not. */
const BY_NAME: Readonly<Record<string, string>> = {
  dockerfile: "docker",
  makefile: "make",
  gnumakefile: "make",
  "cmakelists.txt": "cmake",
  gemfile: "ruby",
  rakefile: "ruby",
  podfile: "ruby",
  justfile: "just",
};

/** Extensions Shiki has no name for, by the language they are written in. */
const BY_EXTENSION: Readonly<Record<string, string>> = {
  h: "c",
  hpp: "cpp",
  hh: "cpp",
  cc: "cpp",
  cxx: "cpp",
  m: "objective-c",
  mm: "objective-cpp",
  ex: "elixir",
  exs: "elixir",
  ml: "ocaml",
  mli: "ocaml",
  htm: "html",
  svg: "xml",
  pyi: "python",
  mk: "make",
  env: "dotenv",
  sol: "solidity",
};

/**
 * The language to colour a file in, by its name.
 *
 * @remarks
 * SPEC-0001 ("M1.12 的文件与更改 · 查看标签"): by the extension, as Shiki names languages and
 * their aliases (`ts`, `py`, `yml`), with a few names and extensions it does not know; a leading
 * dot starts the extension, so `.env` is `dotenv`. Ignoring case.
 *
 * @sideEffects none
 * @param path - The file's path or name.
 * @param languages - The languages Shiki has.
 * @returns The language's id, or `null` to show the text without colours.
 */
export function languageOf(path: string, languages: readonly LanguageInfo[]): string | null {
  // Stryker disable next-line StringLiteral: splitting always gives a last part, so the fallback never runs.
  const name = (path.split("/").at(-1) ?? "").toLowerCase();
  const named = BY_NAME[name];
  if (named !== undefined) return named;
  const dot = name.lastIndexOf(".");
  if (dot === -1) return null;
  const extension = name.slice(dot + 1);
  const known = languages.find((language) => language.id === extension || language.aliases?.includes(extension));
  return known?.id ?? BY_EXTENSION[extension] ?? null;
}
