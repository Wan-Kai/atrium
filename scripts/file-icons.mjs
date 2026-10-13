/**
 * Generates the file-type icons the UI shows, from material-icon-theme (design-language, "消息流 ·
 * 文件胶囊").
 *
 * @remarks
 * Run after changing the pinned `material-icon-theme` version: `node scripts/file-icons.mjs`. It
 * writes `packages/ui/src/files/file-icons.json`, the theme's file names and extensions (both in
 * lower case) with their light variants, and copies the icons they name, and no others, with the
 * theme's licence, into `packages/ui/public/file-icons/`, where the UI loads each when first shown.
 */
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const root = join(import.meta.dirname, "..");
const require = createRequire(join(root, "package.json"));
const theme = dirname(require.resolve("material-icon-theme/package.json"));
const { version } = JSON.parse(await readFile(join(theme, "package.json"), "utf8"));
const manifest = JSON.parse(await readFile(join(theme, "dist", "material-icons.json"), "utf8"));
const out = join(root, "packages", "ui", "public", "file-icons");

/**
 * A manifest table with its keys in lower case.
 *
 * @remarks
 * Matching ignores case; where two keys differ only in case, the one already in lower case wins.
 *
 * @sideEffects none
 * @param {Record<string, string>} table - Names or extensions to icon names.
 * @returns {Record<string, string>} The table, keys in lower case and sorted.
 */
function lowered(table) {
  const result = {};
  for (const [key, icon] of Object.entries(table).toSorted(
    ([a], [b]) => (a === a.toLowerCase()) - (b === b.toLowerCase()),
  )) {
    result[key.toLowerCase()] = icon;
  }
  return Object.fromEntries(Object.entries(result).toSorted(([a], [b]) => (a < b ? -1 : 1)));
}

const table = {
  source: `material-icon-theme ${version}`,
  file: manifest.file,
  fileNames: lowered(manifest.fileNames),
  fileExtensions: lowered(manifest.fileExtensions),
  light: {
    file: manifest.light.file ?? manifest.file,
    fileNames: lowered(manifest.light.fileNames ?? {}),
    fileExtensions: lowered(manifest.light.fileExtensions ?? {}),
  },
};
const used = new Set([
  table.file,
  table.light.file,
  ...Object.values(table.fileNames),
  ...Object.values(table.fileExtensions),
  ...Object.values(table.light.fileNames),
  ...Object.values(table.light.fileExtensions),
]);

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
for (const icon of [...used].toSorted((a, b) => (a < b ? -1 : 1))) {
  // Saved by the icon's name: a clone's file is named otherwise, as `advpl-include.clone.svg`.
  await copyFile(join(theme, "dist", manifest.iconDefinitions[icon].iconPath), join(out, `${icon}.svg`));
}
await copyFile(join(theme, "LICENSE"), join(out, "LICENSE"));
await writeFile(join(root, "packages", "ui", "src", "files", "file-icons.json"), `${JSON.stringify(table, null, 2)}\n`);
console.log(`${used.size} icons from material-icon-theme ${version}`);
