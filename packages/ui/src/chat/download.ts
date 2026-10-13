/**
 * Saves text as a file through the browser's download.
 *
 * @remarks
 * In the app, Electron asks where to save it. Shared by "导出为 Markdown" and `/export`
 * (SPEC-0001, "M1.11 的 `/` 命令").
 *
 * @sideEffects Creates and revokes an object URL; clicks a temporary link.
 * @param name - The file's name.
 * @param text - Its content.
 * @param type - Its media type, with its charset.
 */
export function download(name: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}
