import { useState, type ReactNode } from "react";
import type { Node } from "jsonc-parser";
import { CodeBlock, type CustomRendererProps } from "streamdown";
import { CopyButton } from "./messages";
import {
  parseReplyCsv,
  parseReplyJson,
  type ReplyDataFailure,
  type ReplyDataResult,
  type ReplyCsv,
} from "./reply-data";
import "./reply-data.css";

/** Content-free explanations, never parser diagnostics or snippets. */
const FAILURES: Record<ReplyDataFailure, string> = {
  empty: "内容为空，保留源码。",
  size: "内容超过 64 KiB，保留源码。",
  depth: "JSON 超过 64 层，保留源码。",
  nodes: "JSON 超过 2000 个节点，保留源码。",
  invalid: "数据无法解析，保留源码。",
  rows: "CSV 超过 200 行数据，保留源码。",
  columns: "CSV 超过 50 列，保留源码。",
  cells: "CSV 超过 5000 个单元格，保留源码。",
};

/** The two complete parse outcomes remain discriminated without projecting the JSON tree. */
type ParsedData =
  | { readonly kind: "json"; readonly result: ReplyDataResult<Node> }
  | { readonly kind: "csv"; readonly result: ReplyDataResult<ReplyCsv> };

/** Shows original code while streaming and scopes complete reading state to source and language.
 * @remarks Theme changes do not reset reading choices; source/language changes must reset them.
 * @sideEffects none
 * @param props - Streamdown's unchanged code, language and incomplete flag.
 * @returns A source block or a bounded local data viewer.
 */
export function ReplyDataBlock({ code: source, language, isIncomplete }: CustomRendererProps) {
  if (isIncomplete)
    return (
      <div className="atrium-reply-data">
        <DataSource source={source} language={language} incomplete />
        <p className="atrium-reply-data-note" role="status">
          代码块未闭合，保留源码。
        </p>
      </div>
    );
  return <FinishedData key={`${language}:${source}`} source={source} language={language} />;
}

/** Props shared by the original-source presentation. */
interface SourceProps {
  /** The exact original fence content. */
  readonly source: string;
  /** The registered code-fence language. */
  readonly language: string;
  /** Whether Streamdown is still receiving the fence. */
  readonly incomplete?: boolean;
  /** Optional view-switch button alongside the clock-backed copy control. */
  readonly action?: ReactNode;
}

/** Reuses Streamdown highlighting and the existing clock-backed clipboard button.
 * @remarks CopyButton uses UiClock; Streamdown's copy control owns an uninjected timer.
 * @sideEffects Writes original source to the clipboard only when clicked.
 * @param props - The original code and optional view control.
 * @returns The existing source presentation, without line numbers.
 */
function DataSource({ source, language, incomplete = false, action }: SourceProps) {
  return (
    <>
      <div className="atrium-reply-data-head">
        <span>{language}</span>
        {action}
        <CopyButton label="复制原文" text={() => source} />
      </div>
      <CodeBlock code={source} language={language} isIncomplete={incomplete} lineNumbers={false} />
    </>
  );
}

/** Owns one complete fence's parse outcome and selected view.
 * @remarks JSON is parsed only on request; CSV is parsed once for its default table.
 * @sideEffects Updates local reading state; child copy control writes to the clipboard.
 * @param props - The complete original source and its language.
 * @returns A tree, table, or unchanged source with a short failure explanation.
 */
function FinishedData({ source, language }: { readonly source: string; readonly language: string }) {
  const [parsed, setParsed] = useState<ParsedData | null>(() =>
    language === "csv"
      ? { kind: "csv", result: parseReplyCsv(source) }
      : source.trim().length === 0
        ? { kind: "json", result: { ok: false, reason: "empty" } }
        : null,
  );
  const [showData, setShowData] = useState(language === "csv");
  const showingData = showData && parsed?.result.ok === true;
  const failure = parsed !== null && !parsed.result.ok ? parsed.result.reason : null;
  const action = (
    <button
      type="button"
      className="atrium-reply-data-switch atrium-press-sm"
      disabled={failure !== null}
      onClick={() => {
        if (!showingData && parsed === null) setParsed({ kind: "json", result: parseReplyJson(source) });
        setShowData(!showingData);
      }}
    >
      {showingData ? "源码" : "查看数据"}
    </button>
  );
  return (
    <div className="atrium-reply-data">
      {showingData ? (
        <>
          <div className="atrium-reply-data-head">
            <span>{language}</span>
            {action}
            <CopyButton label="复制原文" text={() => source} />
          </div>
          {parsed.kind === "json" && parsed.result.ok ? (
            <div className="atrium-reply-data-tree" aria-label="JSON 数据">
              <JsonBranch node={parsed.result.value} source={source} root />
            </div>
          ) : parsed.kind === "csv" && parsed.result.ok ? (
            <CsvTable data={parsed.result.value} />
          ) : null}
        </>
      ) : (
        <DataSource source={source} language={language} action={action} />
      )}
      {failure === null ? null : (
        <p className="atrium-reply-data-note" role="status">
          {FAILURES[failure]}
        </p>
      )}
    </div>
  );
}

/** Props of a JSON subtree, retaining source positions rather than numeric values. */
interface BranchProps {
  /** The strict, budget-checked AST node. */
  readonly node: Node;
  /** The exact source from which the node was parsed. */
  readonly source: string;
  /** The property or array index, displayed as inert text. */
  readonly label?: string;
  /** Only the root container begins expanded. */
  readonly root?: boolean;
}

/** Displays one JSON container or scalar without interpreting its contents.
 * @remarks AST arrays preserve duplicate keys, order, large integers and __proto__ safely.
 * Native details provide keyboard-operable expansion without a second tree state model.
 * @sideEffects none
 * @param props - The node, original source and optional label.
 * @returns A native expandable container or inert scalar text.
 */
function JsonBranch({ node, source, label, root = false }: BranchProps) {
  if (node.type !== "object" && node.type !== "array")
    return (
      <div className="atrium-reply-data-leaf">
        {label === undefined ? null : <span>{label}: </span>}
        <span className={`atrium-reply-data-value atrium-reply-data-${node.type}`}>
          {source.slice(node.offset, node.offset + node.length)}
        </span>
      </div>
    );
  const children = node.children ?? [];
  return (
    <details open={root}>
      <summary>
        {label === undefined ? null : <span>{label}</span>}
        <span className="atrium-reply-data-bracket">{node.type === "object" ? "{…}" : "[…]"}</span>
        <span className="atrium-reply-data-type">
          {node.type === "object" ? `对象 · ${children.length} 个属性` : `数组 · ${children.length} 项`}
        </span>
      </summary>
      <div className="atrium-reply-data-children">
        {children.map((child, index) => {
          if (node.type === "array")
            return <JsonBranch key={child.offset} node={child} source={source} label={String(index)} />;
          const key = child.children?.[0];
          const value = child.children?.[1];
          return key === undefined || value === undefined ? null : (
            <JsonBranch
              key={child.offset}
              node={value}
              source={source}
              label={source.slice(key.offset, key.offset + key.length)}
            />
          );
        })}
      </div>
    </details>
  );
}

/** Shows CSV cells in source order, without links, coercion or execution.
 * @remarks The first record is always the header; empty and duplicate labels remain unchanged.
 * @sideEffects none
 * @param props - A complete validated CSV parse.
 * @returns A semantic, scrollable data table.
 */
function CsvTable({ data }: { readonly data: ReplyCsv }) {
  return (
    <>
      <div className="atrium-reply-data-table" tabIndex={0} role="region" aria-label="CSV 数据">
        <table>
          <thead>
            <tr>
              {data.headers.map((header, index) => (
                <th scope="col" key={index}>
                  {header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.rows.map((row, index) => (
              <tr key={index}>
                {row.map((cell, column) => (
                  <td key={column}>{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="atrium-reply-data-note">
        {data.rows.length} 行数据 · {data.headers.length} 列 · 首行作为表头 · 原始顺序
      </p>
    </>
  );
}
