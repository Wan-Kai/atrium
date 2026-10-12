/** The kinds of file a file chip tells apart, each with its own mark (design-language, "文件胶囊"). */
export type FileKind =
  | "ts"
  | "react"
  | "js"
  | "npm"
  | "json"
  | "md"
  | "css"
  | "html"
  | "py"
  | "rs"
  | "go"
  | "sh"
  | "java"
  | "kotlin"
  | "swift"
  | "php"
  | "dart"
  | "c"
  | "vue"
  | "docker"
  | "sql"
  | "image"
  | "svg"
  | "pdf"
  | "csv"
  | "xml"
  | "git"
  | "lock"
  | "config"
  | "text"
  | "archive"
  | "file";

/** Files known by their whole name, in lower case; these go before extensions. */
const BY_NAME: Readonly<Record<string, FileKind>> = {
  "package.json": "npm",
  "pnpm-lock.yaml": "lock",
  "package-lock.json": "lock",
  dockerfile: "docker",
  ".gitignore": "git",
  ".gitattributes": "git",
  ".gitmodules": "git",
  ".env": "config",
};

/** Files known by what their name starts with, in lower case. */
const BY_PREFIX: readonly (readonly [string, FileKind])[] = [
  ["dockerfile.", "docker"],
  [".env.", "config"],
];

/** Files known by their extension, in lower case. */
const BY_EXTENSION: Readonly<Record<string, FileKind>> = {
  ts: "ts",
  mts: "ts",
  cts: "ts",
  tsx: "react",
  jsx: "react",
  js: "js",
  mjs: "js",
  cjs: "js",
  json: "json",
  jsonc: "json",
  json5: "json",
  md: "md",
  mdx: "md",
  markdown: "md",
  css: "css",
  scss: "css",
  sass: "css",
  less: "css",
  html: "html",
  htm: "html",
  py: "py",
  pyi: "py",
  rs: "rs",
  go: "go",
  sh: "sh",
  bash: "sh",
  zsh: "sh",
  fish: "sh",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  swift: "swift",
  php: "php",
  dart: "dart",
  c: "c",
  h: "c",
  cc: "c",
  cpp: "c",
  cxx: "c",
  hpp: "c",
  vue: "vue",
  dockerfile: "docker",
  sql: "sql",
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  ico: "image",
  bmp: "image",
  avif: "image",
  svg: "svg",
  pdf: "pdf",
  csv: "csv",
  tsv: "csv",
  xml: "xml",
  lock: "lock",
  yml: "config",
  yaml: "config",
  toml: "config",
  ini: "config",
  conf: "config",
  cfg: "config",
  properties: "config",
  txt: "text",
  log: "text",
  zip: "archive",
  tar: "archive",
  gz: "archive",
  tgz: "archive",
  "7z": "archive",
  rar: "archive",
};

/**
 * What kind of file a path names, for its chip's mark.
 *
 * @remarks
 * By the file's name first (`package.json`, `Dockerfile`, lock files, `.gitignore`, `.env`), then
 * by its extension, ignoring case; anything else is a plain file (design-language, "文件胶囊").
 * A name starting with its only dot has no extension, as `.prettierrc`.
 *
 * @sideEffects none
 * @param path - The file's path.
 * @returns Its kind.
 */
export function fileKind(path: string): FileKind {
  // Stryker disable next-line StringLiteral: splitting always gives a last part, so the fallback never runs.
  const name = (path.split("/").at(-1) ?? "").toLowerCase();
  const named = BY_NAME[name] ?? BY_PREFIX.find(([prefix]) => name.startsWith(prefix))?.[1];
  if (named !== undefined) return named;
  const dot = name.lastIndexOf(".");
  return (dot > 0 ? BY_EXTENSION[name.slice(dot + 1)] : undefined) ?? "file";
}
