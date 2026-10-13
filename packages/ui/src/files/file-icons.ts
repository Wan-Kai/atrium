import table from "./file-icons.json";

/** One theme's lookups: by whole name, by extension, and the icon for neither. */
interface IconLookups {
  readonly file: string;
  readonly fileNames: Readonly<Record<string, string>>;
  readonly fileExtensions: Readonly<Record<string, string>>;
}

/**
 * The icon for a file name, from the lookups in order of preference.
 *
 * @remarks
 * The whole name first, then each extension from the longest: `panes.test.ts` tries `test.ts`,
 * then `ts`. As in VS Code, a leading dot starts one too, so `.env` has the extension `env`. At
 * each step the first lookup that knows the key wins, so a light variant never beats a better
 * match.
 *
 * @sideEffects none
 * @param lookups - The lookups, the preferred first.
 * @param name - The file name, in lower case.
 * @returns The icon's name, or the plain file icon.
 */
function lookUp(lookups: readonly IconLookups[], name: string): string {
  const named = lookups.map((one) => one.fileNames[name]).find((icon) => icon !== undefined);
  if (named !== undefined) return named;
  for (let dot = name.indexOf("."); dot !== -1; dot = name.indexOf(".", dot + 1)) {
    const extension = name.slice(dot + 1);
    const found = lookups.map((one) => one.fileExtensions[extension]).find((icon) => icon !== undefined);
    if (found !== undefined) return found;
  }
  return table.file;
}

/**
 * The material-icon-theme icon for a file.
 *
 * @remarks
 * design-language ("消息流 · 文件胶囊"): by the theme's manifest, ignoring case, the whole name
 * and then the longest extension; the theme's plain file icon when neither is known. In the light
 * appearance the theme's light variant goes first wherever it has one, as VS Code's.
 *
 * @sideEffects none
 * @param path - The file's path or name.
 * @param light - Whether the appearance is light.
 * @returns The icon's name, which is its file's name in `public/file-icons` without `.svg`.
 */
export function fileIconName(path: string, light: boolean): string {
  // Stryker disable next-line StringLiteral: splitting always gives a last part, so the fallback never runs.
  const name = (path.split("/").at(-1) ?? "").toLowerCase();
  return lookUp(light ? [table.light, table] : [table], name);
}
