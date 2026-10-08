/** The longest prompt line the list carries (SPEC-0001, "项目、工作区与会话"). */
export const PROMPT_LINE_LIMIT = 200;

/**
 * The fallback title of a session: the first line of its first prompt, without Markdown.
 *
 * @remarks
 * SPEC-0001 ("命名"): the first line of the first user message, Markdown symbols and surrounding
 * whitespace removed; the UI shortens what does not fit. Leading blank lines are skipped. Links
 * and images keep their text, code keeps its content; heading, quote and list markers, emphasis
 * and backticks go. The result is cut at `PROMPT_LINE_LIMIT` characters, never inside one.
 *
 * @sideEffects none
 * @param prompt - The first prompt's text.
 * @returns The line, or `null` when nothing is left.
 */
export function promptLine(prompt: string | null): string | null {
  if (prompt === null) return null;
  const first = prompt.trim().split("\n")[0] ?? "";
  const plain = first
    .replace(/^\s*(?:#{1,6}(?:\s+|$)|>\s*|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)+/, "")
    .replaceAll(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replaceAll(/(\*\*|__|~~|`)/g, "")
    // Single-character emphasis only where it opens and closes against text, as CommonMark has it.
    .replaceAll(/(^|[^\w*])[*_](?!\s)([^*_]*[^*_\s])[*_](?=[^\w*]|$)/g, "$1$2")
    .trim();
  if (plain === "") return null;
  // By code point, so a character outside the BMP is never cut in half.
  return Array.from(plain).slice(0, PROMPT_LINE_LIMIT).join("");
}
