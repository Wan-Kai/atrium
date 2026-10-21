import { CommandError, type AtriumClient } from "@atrium/client";
import { type ComponentProps, createContext, useContext, useEffect, useState } from "react";
import type { ExtraProps } from "streamdown";
import { ImagePreview } from "./image-preview";
import { replyImageSource, type ReplyImageSource } from "./reply-image-source";

/** Finds a linked image's text label so its preview and destination can be sibling controls.
 * @remarks Native anchors and file buttons must not contain the image's own preview button.
 * @sideEffects none
 * @param node - The sanitized link tree, including formatted image labels.
 * @returns The first image's label, or null for an ordinary text link.
 */
export function replyImageLabel(node: ExtraProps["node"]): string | null {
  if (node === undefined) return null;
  if (node.tagName === "atrium-image" || node.tagName === "img")
    return typeof node.properties.alt === "string" && node.properties.alt !== "" ? node.properties.alt : "图片链接";
  for (const child of node.children) {
    if (child.type !== "element") continue;
    const label = replyImageLabel(child);
    if (label !== null) return label;
  }
  return null;
}

/** The workspace's existing, guarded image reader. */
interface ReplyImageFiles {
  readonly dir: string;
  readonly load: (path: string) => Promise<string>;
}

/** The current workspace; an unbound chat cannot read arbitrary local files. */
export const ReplyImagesContext = createContext<ReplyImageFiles | null>(null);

/** Creates the reply-image reader on top of the existing file protocol.
 * @remarks No new arbitrary-file endpoint is introduced. The host still rejects links, excessive
 * images, and paths outside the workspace; text and SVG file content never become image URLs.
 * @sideEffects none until used; loading sends read_file.
 * @param client - The existing client.
 * @param workspaceId - The current workspace.
 * @param dir - Its absolute root, used only to resolve Markdown paths.
 * @returns The narrow image reader.
 */
export function replyImageFiles(client: AtriumClient, workspaceId: string, dir: string): ReplyImageFiles {
  return {
    dir,
    load: async (path) => {
      const { content } = await client.readFile(workspaceId, path);
      if (content.kind !== "image") throw new Error(content.kind);
      return `data:${content.mimeType};base64,${content.data}`;
    },
  };
}

/** Describes a failed image without displaying file content or arbitrary error messages.
 * @remarks Local read failures remain actionable, but raw host/decoder errors are never shown.
 * @sideEffects none
 * @param error - The failure.
 * @returns A short Chinese explanation.
 */
function failureText(error: unknown): string {
  if (error instanceof CommandError && error.code === "path_not_found") return "图片不在了";
  if (error instanceof Error && error.message === "too_large") return "图片太大（超过 10 MiB）";
  if (error instanceof Error && error.message === "link") return "不能显示链接指向的图片";
  if (error instanceof Error && (error.message === "text" || error.message === "binary")) return "不是可显示的图片";
  return "图片无法显示";
}

/** Props supplied by Streamdown's image component slot. */
type ReplyImageProps = ComponentProps<"img"> & { readonly node?: unknown };

/** Displays a Markdown image only through an approved remote URL or guarded workspace read.
 * @remarks Local paths must never fall through to the page's static asset loader. The keyed
 * child discards decoder/read state and an open preview when its source or workspace changes.
 * @sideEffects May read an image or open its preview through the child.
 * @param props - The image address and alternative text from Markdown.
 * @returns An image, a plain HTTP link, or an explanation.
 */
export function ReplyImage({ node: _node, src, alt = "", ...props }: ReplyImageProps) {
  const files = useContext(ReplyImagesContext);
  const source = typeof src === "string" ? replyImageSource(src, files?.dir ?? null) : { kind: "blocked" as const };
  if (source.kind === "link")
    return (
      <a
        href={source.src}
        target="_blank"
        rel="noopener noreferrer"
        className="text-tint underline-offset-2 hover:underline"
      >
        {alt === "" ? source.src : alt}
      </a>
    );
  if (source.kind === "blocked")
    return <span className="text-[var(--text-muted)]">不能显示这张图片：路径或格式不受支持</span>;
  return (
    <LoadedImage
      key={`${files?.dir ?? ""}\n${String(src)}`}
      source={source}
      files={files}
      alt={alt}
      imageProps={props}
    />
  );
}

/** A resolved image's local loading state. */
type Reading =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly src: string }
  | { readonly kind: "failed"; readonly text: string };

/** Props shared by an image's retry owner and its current attempt. */
interface LoadedImageProps {
  readonly source: Exclude<ReplyImageSource, { kind: "blocked" } | { kind: "link" }>;
  readonly files: ReplyImageFiles | null;
  readonly alt: string;
  readonly imageProps: Omit<ReplyImageProps, "node" | "src" | "alt">;
}

/** Restarts image loading and decoding as one fresh attempt.
 * @remarks A retry must release the previous preview and decoder state as well as repeat the read.
 * @sideEffects Replaces the attempt when the user retries.
 * @param props - The approved image and reader.
 * @returns The current attempt.
 */
function LoadedImage(props: LoadedImageProps) {
  const [attempt, retry] = useState(0);
  return <ImageAttempt key={attempt} {...props} onRetry={() => retry(attempt + 1)} />;
}

/** Loads one approved source and owns the lifetime of its fullscreen preview.
 * @remarks A late read cannot update a different source. Only already allowed URLs reach img;
 * loading/decoder failures have an explicit retry rather than the browser's broken-image icon.
 * @sideEffects Reads through the host, loads the image and conditionally mounts a modal preview.
 * @param props - The approved source, workspace reader, description and remaining image attributes.
 * @returns The image button or loading/failure explanation.
 */
function ImageAttempt({
  source,
  files,
  alt,
  imageProps,
  onRetry,
}: LoadedImageProps & { readonly onRetry: () => void }) {
  const [reading, setReading] = useState<Reading>(() =>
    source.kind === "remote" ? { kind: "ready", src: source.src } : { kind: "loading" },
  );
  const [failedDecode, setFailedDecode] = useState(false);
  const [preview, showPreview] = useState(false);
  const path = source.kind === "local" ? source.path : null;
  useEffect(() => {
    let live = true;
    if (path !== null && files !== null)
      files.load(path).then(
        (src) => {
          if (live) setReading({ kind: "ready", src });
          return undefined;
        },
        (error: unknown) => {
          if (live) setReading({ kind: "failed", text: failureText(error) });
        },
      );
    return () => {
      live = false;
    };
  }, [files, path]);
  if (reading.kind !== "ready" || failedDecode)
    return (
      <span className="inline-flex items-center gap-2 text-[var(--text-muted)]" role="status">
        {failedDecode ? "图片无法显示" : reading.kind === "failed" ? reading.text : "正在读取图片…"}
        {reading.kind === "failed" || failedDecode ? (
          <button type="button" className="atrium-press text-[var(--tint)]" onClick={onRetry}>
            重试
          </button>
        ) : null}
      </span>
    );
  return (
    <>
      <button
        type="button"
        aria-label={`放大图片：${alt === "" ? "图片" : alt}`}
        className="block max-w-full cursor-zoom-in rounded-[var(--r-md)]"
        onClick={() => showPreview(true)}
      >
        <img
          {...imageProps}
          src={reading.src}
          alt={alt}
          loading="lazy"
          onError={() => {
            setFailedDecode(true);
            showPreview(false);
          }}
          className="max-w-full rounded-[var(--r-md)]"
        />
      </button>
      {preview ? (
        <ImagePreview src={reading.src} alt={alt === "" ? "图片" : alt} onClose={() => showPreview(false)} />
      ) : null}
    </>
  );
}
