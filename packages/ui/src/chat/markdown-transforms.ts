/** A node of a Markdown syntax tree, as far as the transforms here look at it. */
interface MarkdownNode {
  type: string;
  value?: string;
  children?: MarkdownNode[];
}

/** Inline code: a run of backticks, anything else, and a closing run; captured so `split` keeps it. */
// Stryker disable next-line Regex: a shorter closing run only splits the code differently; the math outside is the same.
const INLINE_CODE = /(`+[^`]*`+)/;

/** An opening or closing code fence: three or more backticks or tildes. */
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * Rewrites `\(…\)` inline math as `$$…$$`, outside code.
 *
 * @remarks
 * SPEC-0001 ("回复渲染") asks for `$$…$$` and `\(…\)` and not single dollars, which clash with
 * shell variables and prices. The math plugin's parser (remark-math) knows only dollars, and
 * reads `$$…$$` inside a line as inline math, so this is the one translation needed. Fenced code
 * and inline code are left alone; an unclosed fence, as while a reply streams, covers the rest of
 * the text. Only what is rendered is rewritten: copying uses the original text.
 *
 * @sideEffects none
 * @param markdown - The reply as written.
 * @returns The text to render.
 */
export function normalizeMathDelimiters(markdown: string): string {
  let fence: string | null = null;
  return markdown
    .split("\n")
    .map((line) => {
      const marker = FENCE.exec(line)?.[1];
      if (fence !== null) {
        if (marker !== undefined && marker[0] === fence[0] && marker.length >= fence.length) fence = null;
        return line;
      }
      if (marker !== undefined) {
        fence = marker;
        return line;
      }
      // Odd pieces are inline code; a backtick run without a partner stays plain text.
      return line
        .split(INLINE_CODE)
        .map((piece, index) =>
          index % 2 === 1 ? piece : piece.replaceAll(/\\\((.+?)\\\)/g, (_match, math: string) => `$$${math}$$`),
        )
        .join("");
    })
    .join("\n");
}

/**
 * Turns every HTML node at or below `node` into a text node with the same source.
 *
 * @remarks
 * Walks the whole tree; HTML appears both as blocks and inline.
 *
 * @sideEffects Mutates the tree in place, as remark plugins do.
 * @param node - The node to walk.
 */
function htmlToText(node: MarkdownNode): void {
  if (node.type === "html") node.type = "text";
  for (const child of node.children ?? []) htmlToText(child);
}

/**
 * A remark plugin that shows raw HTML as the text it is.
 *
 * @remarks
 * Replies never run HTML (SPEC-0001, "回复渲染"; security.md, "渲染内容"). Dropping it would hide
 * part of what the model wrote, so each HTML node becomes a text node with the same source, which
 * the renderer escapes. Streamdown's own HTML handling then has nothing left to parse.
 *
 * @sideEffects none
 * @returns The tree transformer.
 */
export function remarkHtmlAsText(): (tree: MarkdownNode) => void {
  return htmlToText;
}
