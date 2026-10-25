import { replyFileTarget } from "./reply-file-target";

/** A node of a Markdown syntax tree, as far as the transforms here look at it. */
interface MarkdownNode {
  type: string;
  value?: string;
  children?: MarkdownNode[];
  url?: string;
  alt?: string;
  title?: string | null;
  identifier?: string;
  lang?: string | null;
  position?: { start: { offset?: number }; end: { offset?: number } };
  data?: { hName?: string; hProperties?: Record<string, string> };
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

/** A line starting with a pipe, as a table's rows do. */
const PIPE_ROW = /^ {0,3}\|/u;

/** A pipe between table cells, not an escaped one. */
const CELL_PIPE = /(?<!\\)\|/u;

/** A delimiter row's cell: dashes, with a colon at either end for the alignment. */
const DELIMITER_CELL = /^\s*:?-+:?\s*$/u;

/** The start of a delimiter row's cell, still being written. */
const DELIMITER_CELL_START = /^\s*:?-*:?\s*$/u;

/** An opening code fence: a backtick one's info string has no backtick. */
const OPENING_FENCE = /^ {0,3}(?:(`{3,})[^`]*|(~{3,}).*)$/u;

/** A closing code fence: nothing but spaces after it. */
// Stryker disable next-line Regex: a fence shorter than three never closes one, at least three long.
const CLOSING_FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/u;

/**
 * The start of a block that ends a table, after which a pipe line is a paragraph's: a heading or a
 * code fence. After a quote or a list item it would go on their paragraph instead.
 */
const BLOCK_START = /^ {0,3}(?:#{1,6}(?:[ \t]|$)|`{3,}|~{3,})/u;

/**
 * A table row's cells, without its outer pipes.
 *
 * @remarks
 * An escaped pipe stays inside its cell, as GFM reads it.
 *
 * @sideEffects none
 * @param line - The row.
 * @returns The cells' text.
 */
function cellsOf(line: string): string[] {
  // Stryker disable next-line Regex: the header passed PIPE_ROW, so once trimmed it starts with its pipe.
  const cells = line.trim().replace(/^\|/u, "").split(CELL_PIPE);
  // Trimmed, a row ending in a pipe leaves exactly an empty last piece.
  return cells.at(-1) === "" ? cells.slice(0, -1) : cells;
}

/**
 * Whether a line is the start of a delimiter row with fewer columns than its header.
 *
 * @remarks
 * Every cell but the last is whole; the last may still be empty or half written.
 *
 * @sideEffects none
 * @param line - The line after the header.
 * @param columns - How many columns the header has.
 * @returns Whether the delimiter row has still to be finished.
 */
function unfinishedDelimiter(line: string, columns: number): boolean {
  const whole = line.trim().replace(/^\|/u, "").split(CELL_PIPE);
  // Stryker disable next-line StringLiteral: split always gives at least one piece.
  const last = whole.pop() ?? "";
  if (!whole.every((cell) => DELIMITER_CELL.test(cell)) || !DELIMITER_CELL_START.test(last)) return false;
  return whole.length + (DELIMITER_CELL.test(last) ? 1 : 0) < columns;
}

/**
 * Whether a line is a whole delimiter row for a header with this many columns.
 *
 * @remarks
 * As GFM reads it: every cell dashes with an optional colon at either end, as many as the
 * header's, with or without the outer pipes.
 *
 * @sideEffects none
 * @param line - The line after the header.
 * @param columns - How many columns the header has.
 * @returns Whether it makes the header a table's.
 */
function delimiterRow(line: string, columns: number): boolean {
  const cells = cellsOf(line);
  return cells.length === columns && cells.every((cell) => DELIMITER_CELL.test(cell));
}

/**
 * Whether a line is one of a table's rows: a delimiter row, or a row after one.
 *
 * @remarks
 * A table goes on to the first blank line or the start of another block, whatever the rows look
 * like, pipes or not (GFM). So the lines before it, back to such a break, are looked through for
 * a header with its delimiter row.
 *
 * @sideEffects none
 * @param lines - The reply's lines.
 * @param at - The line's index.
 * @returns Whether it is in a table.
 */
function inTable(lines: readonly string[], at: number): boolean {
  // Stryker disable next-line EqualityOperator: before the first line there is none, read as blank.
  for (let row = at; row > 0; row -= 1) {
    // Stryker disable next-line StringLiteral: `row` stays within the lines.
    const header = lines[row - 1] ?? "";
    if (header.trim() === "" || BLOCK_START.test(header)) return false;
    // Stryker disable next-line StringLiteral: as above.
    if (delimiterRow(lines[row] ?? "", cellsOf(header).length)) return true;
  }
  return false;
}

/**
 * Whether a line is inside fenced code, by the fences before it.
 *
 * @remarks
 * A fence closes only with the same character, at least as long, and nothing but spaces after it
 * (CommonMark); an unclosed fence takes in the rest of the text.
 *
 * @sideEffects none
 * @param lines - The reply's lines.
 * @param at - The line's index.
 * @returns Whether it is code.
 */
function inCode(lines: readonly string[], at: number): boolean {
  let fence: string | null = null;
  // Stryker disable next-line MethodExpression: the header and the line after it start with no fence.
  for (const line of lines.slice(0, at)) {
    if (fence === null)
      fence =
        OPENING_FENCE.exec(line)
          ?.slice(1)
          .find((marker) => marker !== undefined) ?? null;
    else {
      const marker = CLOSING_FENCE.exec(line)?.[1];
      if (marker !== undefined && marker[0] === fence[0] && marker.length >= fence.length) fence = null;
    }
  }
  return fence !== null;
}

/**
 * Holds back a table at the end of a streaming reply until its delimiter row has all its columns.
 *
 * @remarks
 * Until then the header is a paragraph, drawn as its pipes; once the delimiter row is written it
 * becomes a table and its text shrinks to the cells', a flash of raw syntax mid-stream (SPEC-0001,
 * "回复渲染"). Only a header starting with a pipe, which is no row of a table already there, and
 * outside code is held; the rest is shown as it is. For streaming text only: once the reply has
 * ended it is shown whole.
 *
 * @sideEffects none
 * @param markdown - The reply received so far.
 * @returns The text to render now.
 */
export function withoutUnfinishedTable(markdown: string): string {
  const lines = markdown.split("\n");
  const last = lines.length - 1;
  // Stryker disable StringLiteral: only before the first line is there none, and that is no pipe row either.
  /**
   * Whether a line could become a table's header: it starts with a pipe and is no row of a table.
   *
   * @remarks
   * A table can start right after a paragraph's line, even one starting with a pipe.
   *
   * @sideEffects none
   * @param at - The line's index.
   */
  const opens = (at: number): boolean => PIPE_ROW.test(lines[at] ?? "") && !inTable(lines, at);
  let header: number;
  if (opens(last - 1) && unfinishedDelimiter(lines[last] ?? "", cellsOf(lines[last - 1] ?? "").length))
    header = last - 1;
  // Stryker restore StringLiteral
  else if (opens(last)) header = last;
  else return markdown;
  return inCode(lines, header) ? markdown : lines.slice(0, header).join("\n");
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

/** Marks data fences by their actual source extent, even after a stream stops.
 * @remarks Streamdown's isIncomplete only covers its animated final block and misses quoted
 * fences. A real closing fence is an extra source line, not part of the AST code value. Counting
 * both handles nested container prefixes without mistaking a literal fence inside code for closure.
 * @sideEffects Adds inert code metadata; neither parses data nor changes code text.
 * @returns The tree transformer, using the source that remark actually parsed.
 */
export function remarkReplyData(): (tree: MarkdownNode, file?: { value?: unknown }) => void {
  return (tree, file) => {
    // Mutation review: remark-produced fenced code is the only node kind with lang, and its
    // opening fence is always a valid run. AST span/value line counts independently distinguish
    // a real close, so widening the opener run/anchor or closing kind/length checks is equivalent
    // for that parser contract. Missing-source sentinel text without fences remains fail-closed.
    // These defensive checks stay explicit; no broad mutator suppression is used.
    const source = typeof file?.value === "string" ? file.value : "";
    /** Annotates only JSON/CSV fenced-code nodes, never arbitrary HTML or inline code.
     * @remarks Source offsets and code value belong to the same Markdown parser run.
     * @sideEffects Adds code properties for the controlled React adapter.
     * @param node - The current node.
     */
    function visit(node: MarkdownNode): void {
      if (node.type === "code" && (node.lang === "json" || node.lang === "csv")) {
        const start = node.position?.start.offset;
        const end = node.position?.end.offset;
        const raw = start === undefined || end === undefined ? "" : source.slice(start, end);
        const lines = raw.split(/\r\n?|\n/u);
        const opening = /^ {0,3}(`{3,}|~{3,})/u.exec(lines[0] ?? "")?.[1];
        const closing = /(`{3,}|~{3,})[ \t]*$/u.exec(lines.at(-1) ?? "")?.[1];
        const closed =
          opening !== undefined &&
          closing !== undefined &&
          opening[0] === closing[0] &&
          closing.length >= opening.length &&
          (node.value === "" || lines.length >= (node.value ?? "").split(/\r\n?|\n/u).length + 2);
        // Reuse Streamdown's existing inert metadata slot; no sanitizer rules are relaxed.
        node.data = {
          ...node.data,
          hProperties: { ...node.data?.hProperties, metastring: closed ? "atrium-data-closed" : "atrium-data-open" },
        };
      }
      for (const child of node.children ?? []) visit(child);
    }
    visit(tree);
  };
}

/** Keeps local reply references inert until the workspace opener validates them.
 * @remarks URL hardening would normalize relative paths or discard file URLs before React saw
 * them. Only Markdown nodes become this custom tag; HTML has already been made text.
 * @sideEffects Changes local-link and selected inline-code rendering metadata.
 * @returns The tree transformer.
 */
export function remarkReplyFiles(): (tree: MarkdownNode) => void {
  const definitions = new Map<string, string>();
  /** Retains Markdown's first-definition semantics without normalizing its URL.
   * @remarks Reference links share their definitions across the complete Markdown document.
   * @sideEffects Populates a per-transform map.
   * @param node - The node being scanned.
   */
  function collect(node: MarkdownNode): void {
    // Mutation review: widening only the identifier/URL shape guards is equivalent for valid
    // remark definitions; undefined map keys cannot be used by a valid reference. False guards,
    // image/reference kind confusion, duplicate definitions and map reuse are tested separately.
    if (
      node.type === "definition" &&
      node.identifier !== undefined &&
      node.url !== undefined &&
      !definitions.has(node.identifier)
    )
      definitions.set(node.identifier, node.url);
    for (const child of node.children ?? []) collect(child);
  }
  /** Visits references without making an inline code label a nested interactive control.
   * @remarks A code block is never an inlineCode node.
   * @sideEffects Updates rendering metadata.
   * @param node - The current node.
   * @param inLink - Whether an ancestor already owns the link interaction.
   */
  function visit(node: MarkdownNode, inLink = false): void {
    const inline = node.type === "inlineCode";
    const source =
      node.type === "link"
        ? node.url
        : // Mutation review: a reference always has an identifier, and the map has no undefined
          // key; widening only that identifier guard leaves output unchanged.
          node.type === "linkReference" && node.identifier !== undefined
          ? definitions.get(node.identifier)
          : inline && !inLink
            ? node.value
            : undefined;
    if (
      source !== undefined &&
      (inline ? replyFileTarget(source, true) !== null : !/^(?:https?:|mailto:|tel:|#)/iu.test(source))
    )
      node.data = { hName: "atrium-file", hProperties: { source, inline: String(inline) } };
    for (const child of node.children ?? [])
      visit(child, inLink || node.type === "link" || node.type === "linkReference");
  }
  return (tree) => {
    definitions.clear();
    collect(tree);
    visit(tree);
  };
}

/** Routes Markdown images to the guarded image component without URL normalization.
 * @remarks rehype-harden intentionally rejects file: and normalizes ./ paths into / paths.
 * The custom element carries the original address as data, not a live src; only ReplyImage can
 * turn it into an image after checking the workspace boundary. All other tags keep Streamdown's
 * default sanitization and hardening. Raw HTML was already made text, so it cannot create this tag.
 * @sideEffects Updates the Markdown tree's rendering metadata.
 * @returns The tree transform.
 */
export function remarkReplyImages(): (tree: MarkdownNode) => void {
  return (tree) => {
    const definitions = new Map<string, string>();
    /** Collects first definitions, matching Markdown's reference resolution.
     * @remarks Reference images need the same original-address preservation as inline images.
     * @sideEffects Updates the local definition map.
     * @param node - The Markdown node.
     */
    function collect(node: MarkdownNode): void {
      // Mutation review: widening these AST shape guards is equivalent for remark trees:
      // definitions always carry identifier/url; no other node kind carries that pair. Collecting
      // an undefined key cannot affect an imageReference, which always has an identifier.
      // Keep the guards explicit; false and duplicate-definition mutations remain tested.
      if (
        node.type === "definition" &&
        node.identifier !== undefined &&
        node.url !== undefined &&
        !definitions.has(node.identifier)
      )
        definitions.set(node.identifier, node.url);
      for (const child of node.children ?? []) collect(child);
    }
    /** Adds a safe custom rendering tag to an image, never to arbitrary HTML.
     * @remarks The URL remains an inert string through the sanitizer and hardener.
     * @sideEffects Changes only image rendering metadata.
     * @param node - The Markdown node.
     */
    function images(node: MarkdownNode): void {
      const source =
        node.type === "image"
          ? node.url
          : // Mutation review: widening the identifier guard is equivalent: the definitions map
            // never has an undefined key, and remark references always carry an identifier.
            node.type === "imageReference" && node.identifier !== undefined
            ? definitions.get(node.identifier)
            : undefined;
      if (source !== undefined)
        node.data = {
          hName: "atrium-image",
          hProperties: { source, alt: node.alt ?? "", ...(node.title == null ? {} : { title: node.title }) },
        };
      for (const child of node.children ?? []) images(child);
    }
    collect(tree);
    images(tree);
  };
}
