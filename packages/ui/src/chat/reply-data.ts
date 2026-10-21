import { createScanner, parseTree, type Node, type ParseError } from "jsonc-parser";

/** Public scanner token values from pinned jsonc-parser 3.3.1.
 * Its ambient const enums cannot be imported with this package's verbatimModuleSyntax.
 */
const JSON_TOKEN = {
  OpenBraceToken: 1,
  CloseBraceToken: 2,
  OpenBracketToken: 3,
  CloseBracketToken: 4,
  LineCommentTrivia: 12,
  BlockCommentTrivia: 13,
  Unknown: 16,
  EOF: 17,
} as const;

/** Stable reasons for retaining the source instead of showing partial data. */
export type ReplyDataFailure = "empty" | "size" | "depth" | "nodes" | "invalid" | "rows" | "columns" | "cells";

/** A complete bounded parse, or a content-free failure reason. */
export type ReplyDataResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: ReplyDataFailure };

/** Checks the common input budget before allocating parser state.
 * @remarks The UTF-16 length shortcut avoids encoding an already oversized string.
 * @sideEffects none
 * @param source - The original source.
 * @returns A content-free failure, or null when parsing may proceed.
 */
function inputFailure(source: string): ReplyDataFailure | null {
  // UTF-8 byte length is never smaller than UTF-16 length, so dropping the first
  // operand preserves outcomes. Keep the shortcut to avoid encoding oversized input.
  if (source.length > 65536 || new TextEncoder().encode(source).byteLength > 65536) return "size";
  if (source.trim().length === 0) return "empty";
  return null;
}

/** Checks JSON lexical validity and container depth without recursion.
 * @remarks Containers, including the root, count as one layer each; scalar roots have depth zero.
 * The same lexer as the parser handles escaped strings. Comments are rejected before parsing:
 * their quotes could otherwise hide deep nesting from a naive quote/bracket scan.
 * @sideEffects none
 * @param source - A size-bounded JSON source.
 * @returns A lexical/depth failure, or null when recursive parsing is safe.
 */
function jsonPreflight(source: string): ReplyDataFailure | null {
  const scanner = createScanner(source, false);
  const containers: number[] = [];
  for (let token: number = scanner.scan(); token !== JSON_TOKEN.EOF; token = scanner.scan()) {
    const scanError: number = scanner.getTokenError();
    if (
      scanError !== 0 ||
      token === JSON_TOKEN.Unknown ||
      token === JSON_TOKEN.LineCommentTrivia ||
      token === JSON_TOKEN.BlockCommentTrivia
    )
      return "invalid";
    if (token === JSON_TOKEN.OpenBracketToken || token === JSON_TOKEN.OpenBraceToken) {
      containers.push(token);
      if (containers.length > 64) return "depth";
    } else if (token === JSON_TOKEN.CloseBracketToken || token === JSON_TOKEN.CloseBraceToken) {
      const expected = token === JSON_TOKEN.CloseBracketToken ? JSON_TOKEN.OpenBracketToken : JSON_TOKEN.OpenBraceToken;
      if (containers.pop() !== expected) return "invalid";
    }
  }
  // A leftover opening delimiter (already bounded to 64 layers) would also make
  // parseTree reject with "invalid"; this check only rejects that input earlier.
  return containers.length === 0 ? null : "invalid";
}

/** A CSV header and its remaining rows, without coercion or formula evaluation. */
export interface ReplyCsv {
  /** The first row, including empty or duplicate labels. */
  readonly headers: readonly string[];
  /** Every data row in source order. */
  readonly rows: readonly (readonly string[])[];
}

/** Parses comma-separated fields with an explicit quote state machine.
 * @remarks No delimiters are guessed and no cell is evaluated. A terminal newline ends
 * the last row rather than inventing another one. Quoted newlines retain their spelling.
 * @sideEffects none
 * @param source - The complete original fence, optionally beginning with a UTF-8 BOM.
 * @returns All cells, or a content-free error without partial results.
 */
export function parseReplyCsv(source: string): ReplyDataResult<ReplyCsv> {
  if (inputFailure(source) === "size") return { ok: false, reason: "size" };
  const text = source.startsWith("\uFEFF") ? source.slice(1) : source;
  if (text.length === 0) return { ok: false, reason: "empty" };
  const records: string[][] = [];
  let cells = 0;
  let row: string[] = [];
  let field = "";
  let state: "start" | "plain" | "quoted" | "closed" = "start";
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (state === "quoted") {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else state = "closed";
      } else field += character;
      continue;
    }
    if (character === "," || character === "\r" || character === "\n") {
      row.push(field);
      cells += 1;
      if (row.length > 50) return { ok: false, reason: "columns" };
      if (cells > 5000) return { ok: false, reason: "cells" };
      field = "";
      state = "start";
      if (character !== ",") {
        records.push(row);
        if (records.length > 201) return { ok: false, reason: "rows" };
        row = [];
        if (character === "\r" && text[index + 1] === "\n") index += 1;
      }
    } else if (character === '"' && state === "start") state = "quoted";
    else if (character === '"' || state === "closed") return { ok: false, reason: "invalid" };
    else {
      field += character;
      // Only start/quoted/closed are tested; another non-special sentinel has
      // equivalent behavior here. "plain" documents the unquoted-field state.
      state = "plain";
    }
  }
  if (state === "quoted") return { ok: false, reason: "invalid" };
  if (row.length > 0 || state !== "start") {
    row.push(field);
    cells += 1;
    if (row.length > 50) return { ok: false, reason: "columns" };
    if (cells > 5000) return { ok: false, reason: "cells" };
    records.push(row);
    if (records.length > 201) return { ok: false, reason: "rows" };
  }
  // Every nonempty, completed CSV emits at least one record (at a separator or
  // at EOF); the fallback is unreachable, but expresses the indexed-access type.
  const headers = records.shift() ?? [];
  if (records.some((record) => record.length !== headers.length)) return { ok: false, reason: "invalid" };
  return { ok: true, value: { headers, rows: records } };
}

/** Parses strict JSON without projecting it into ordinary JavaScript objects.
 * @remarks AST positions retain exact numeric spelling and duplicate property order.
 * @sideEffects none
 * @param source - The complete original fence.
 * @returns The syntax tree; no partial tree is exposed on failure.
 */
export function parseReplyJson(source: string): ReplyDataResult<Node> {
  const failure = inputFailure(source);
  if (failure !== null) return { ok: false, reason: failure };
  const lexicalFailure = jsonPreflight(source);
  if (lexicalFailure !== null) return { ok: false, reason: lexicalFailure };
  const errors: ParseError[] = [];
  // Preflight already rejects comments and inputFailure rejects empty content.
  // The parser defaults for trailing commas and empty content are also false:
  // removing these options or relaxing comments/empty content is equivalent here.
  // Keep the explicit options to document strict JSON at the recursive boundary.
  const root = parseTree(source, errors, {
    disallowComments: true,
    allowTrailingComma: false,
    allowEmptyContent: false,
  });
  // With empty content disallowed, an undefined root already carries a parse
  // error; checking the root too is equivalent at runtime and narrows its type.
  if (root === undefined || errors.length > 0) return { ok: false, reason: "invalid" };
  // Count every AST node: containers, property nodes, property-name strings and scalar values.
  // Parent pointers are deliberately not traversed; repeated keys remain independent nodes.
  const pending = [root];
  let count = 0;
  while (pending.length > 0) {
    const node = pending.pop();
    count += 1;
    if (count > 2000) return { ok: false, reason: "nodes" };
    // The nonempty stack contains only the valid root and AST children, so pop
    // cannot be undefined; optional and direct access are equivalent here.
    if (node?.children !== undefined) pending.push(...node.children);
  }
  return { ok: true, value: root };
}
