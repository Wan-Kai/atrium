import { type ReactNode, useContext } from "react";
import { FileIcon } from "../files/file-icon";
import { OpenFileContext } from "./file-opener";
import { replyFileTarget } from "./reply-file-target";
import type { ExtraProps } from "streamdown";
import { replyImageLabel } from "./reply-images";

/** Opens only an explicit, validated workspace reference when activated.
 * @remarks Missing workspace capability or unsafe syntax remains text, never an external URL.
 * Raw custom HTML cannot enter this renderer: the remark pipeline first converts it to text.
 * @sideEffects Validates without reading during render; the supplied action opens a file on click.
 * @param props - Inert original Markdown attributes and its already-sanitized label.
 * @returns A file button, or the original code/link label without navigation.
 */
export function ReplyFile({
  source,
  inline,
  children: label,
  node,
}: {
  readonly source?: unknown;
  readonly inline?: unknown;
  readonly children?: ReactNode;
  readonly node?: ExtraProps["node"];
}) {
  const opener = useContext(OpenFileContext);
  const isInline = inline === "true";
  const target = typeof source === "string" ? replyFileTarget(source, isInline) : null;
  const open = target === null || opener === null ? null : opener(target.path, target.range);
  if (open === null)
    return isInline ? <code className="atrium-file-reference-code">{label}</code> : <span>{label}</span>;
  const imageLabel = replyImageLabel(node);
  const button = (
    <button
      type="button"
      title={typeof source === "string" ? source : undefined}
      onClick={open}
      className={`atrium-press atrium-file-reference${isInline ? " atrium-file-reference-code" : ""}`}
    >
      <FileIcon path={target!.path} size={13} />
      <span>{imageLabel ?? label}</span>
    </button>
  );
  return imageLabel === null ? (
    button
  ) : (
    <span>
      {label}
      {button}
    </span>
  );
}
