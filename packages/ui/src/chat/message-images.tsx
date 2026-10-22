import type { AtriumClient } from "@atrium/client";
import { ImageIcon } from "../design/icons";
import { createContext, useContext, useEffect, useState } from "react";
import { ImagePreview } from "./image-preview";

/** Where the images of sent messages come from (SPEC-0001, "消息下方的信息"). */
export interface MessageImages {
  /** The previews of a message sent from this page, by its `clientMessageId`; `null` for others. */
  sent(clientMessageId: string): readonly string[] | null;
  /** One image of a turn's message, as a `data:` address; rejects when the host has none. */
  load(turnId: string, index: number, settled: boolean): Promise<string>;
}

/** The images of the conversation shown; none outside one. */
export const MessageImagesContext = createContext<MessageImages>({
  sent: () => null,
  load: () => Promise.reject(new Error("no conversation")),
});

/** How many fetched images the page keeps, across sessions. */
const KEPT_IMAGES = 100;

/** Fetched images by client, then by session, turn and place. */
const fetched = new WeakMap<AtriumClient, Map<string, Promise<string>>>();

/**
 * The images of one session's messages, fetched from the host once each.
 *
 * @remarks
 * Messages sent from this page show the previews the client kept; others are fetched one image
 * at a time with `fetch_image` (SPEC-0001, "M1.11 的消息图片"). The page keeps the latest
 * {@link KEPT_IMAGES} fetched images of all sessions, so scrolling back or switching tabs does not
 * fetch them again; one the host did not have is not kept, so a turn that ran on can be asked
 * again once it ends. An ask from while the turn ran is not reused once it has ended, as its
 * answer may come too early.
 *
 * @sideEffects Keeps the client's fetched images; loading one sends `fetch_image`.
 * @param client - The client.
 * @param sessionId - The session.
 * @returns The images.
 */
export function messageImages(client: AtriumClient, sessionId: string): MessageImages {
  const kept = fetched.get(client) ?? new Map<string, Promise<string>>();
  fetched.set(client, kept);
  return {
    sent: (clientMessageId) => client.sentPreviews(clientMessageId),
    load(turnId, index, settled) {
      const key = `${sessionId}\n${turnId}\n${index}\n${String(settled)}`;
      const known = kept.get(key);
      if (known !== undefined) return known;
      const loading = client
        .fetchImage(sessionId, turnId, index)
        .then(({ mimeType, data }) => `data:${mimeType};base64,${data}`);
      kept.set(key, loading);
      // The oldest goes first: a Map keeps the order keys were added in.
      for (const old of [...kept.keys()].slice(0, -KEPT_IMAGES)) kept.delete(old);
      loading.catch(() => {
        if (kept.get(key) === loading) kept.delete(key);
      });
      return loading;
    },
  };
}

/** Props of {@link MessageThumbnails}. */
export interface MessageThumbnailsProps {
  /** How many images the message went with. */
  readonly count: number;
  /** The turn the message opened; `null` while it is pending. */
  readonly turnId: string | null;
  /** The message's id from this page, if it was sent from here. */
  readonly clientMessageId: string | null;
  /** Whether the turn has ended: one still running may not be tied to its entry yet. */
  readonly settled: boolean;
}

/**
 * The thumbnails of a sent message's images, in a row above its bubble.
 *
 * @remarks
 * 64 px squares with rounded corners, cropped to fill, wrapping when there are many
 * (SPEC-0001, "消息下方的信息"). A message sent from this page shows the previews kept for it;
 * any other is fetched image by image (see {@link messageImages}). Available thumbnails open the
 * same modal preview as reply images, without fetching another copy.
 *
 * @sideEffects Loads images through {@link MessageImagesContext}; may open an image preview.
 * @param props - The message's images.
 * @returns The thumbnails.
 */
export function MessageThumbnails({ count, turnId, clientMessageId, settled }: MessageThumbnailsProps) {
  const images = useContext(MessageImagesContext);
  const previews = clientMessageId === null ? null : images.sent(clientMessageId);
  return (
    <div className="flex max-w-[80%] flex-wrap justify-end gap-1.5" data-testid="message-images">
      {previews?.length === count
        ? previews.map((src, index) => <Shown key={`${index}:${src}`} src={src} index={index} />)
        : Array.from({ length: count }, (_, index) => (
            // A new key once the turn ends starts the thumbnail over, which asks again.
            <Fetched key={`${String(settled)}:${index}`} turnId={turnId} index={index} settled={settled} />
          ))}
    </div>
  );
}

/** The frame every thumbnail shares. */
const FRAME = "block size-16 shrink-0 rounded-[var(--r-md)] shadow-[0_0_0_0.5px_var(--line)]";

/**
 * One thumbnail whose image is at hand.
 *
 * @remarks
 * Named by its place, as the message has no names for its images. The existing image preview
 * supplies zoom, keyboard controls, modal isolation and focus restoration. Callers key by source
 * so replacing the image tears down its preview instead of keeping a modal open for new pixels.
 *
 * @sideEffects Opens and closes a modal preview when used.
 * @param props - Its address and place.
 * @returns The thumbnail button and, while open, its preview.
 */
function Shown({ src, index }: { readonly src: string; readonly index: number }) {
  const [preview, showPreview] = useState(false);
  const alt = `图片 ${index + 1}`;
  return (
    <>
      <button
        type="button"
        aria-label={`放大图片：${alt}`}
        className="block cursor-zoom-in rounded-[var(--r-md)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--tint)]"
        onClick={() => showPreview(true)}
      >
        <img src={src} alt={alt} className={`${FRAME} object-cover`} />
      </button>
      {preview ? <ImagePreview src={src} alt={alt} onClose={() => showPreview(false)} /> : null}
    </>
  );
}

/**
 * One thumbnail fetched from the host.
 *
 * @remarks
 * Grey while it loads, and while the message is pending, which has no turn to ask about yet; a
 * plain frame with an image mark when the host has no such image (SPEC-0001, "消息下方的信息").
 * Made anew once the turn ends, so a running turn's image, which may have become available, is
 * asked for again.
 *
 * @sideEffects Loads the image while shown.
 * @param props - The turn, the image's place and whether the turn has ended.
 * @returns The thumbnail.
 */
function Fetched({
  turnId,
  index,
  settled,
}: {
  readonly turnId: string | null;
  readonly index: number;
  readonly settled: boolean;
}) {
  const images = useContext(MessageImagesContext);
  const [state, setState] = useState<{ readonly src: string | null; readonly failed: boolean }>({
    src: null,
    failed: false,
  });
  useEffect(() => {
    if (turnId === null) return undefined;
    let current = true;
    /**
     * Loads the image into the thumbnail.
     *
     * @remarks
     * Only while the thumbnail still shows this image; it never rejects.
     *
     * @sideEffects Loads the image; sets component state.
     */
    const show = async (): Promise<void> => {
      try {
        const src = await images.load(turnId, index, settled);
        if (current) setState({ src, failed: false });
      } catch {
        if (current) setState({ src: null, failed: true });
      }
    };
    void show();
    return () => {
      current = false;
    };
  }, [images, turnId, index, settled]);
  if (state.src !== null) return <Shown key={state.src} src={state.src} index={index} />;
  return state.failed ? (
    <span
      role="img"
      aria-label="图片不可用"
      title="图片不可用"
      className={`${FRAME} flex items-center justify-center bg-[var(--surface-2)] text-[var(--text-dim)]`}
    >
      <ImageIcon size={18} />
    </span>
  ) : (
    <span role="img" aria-label="正在加载图片" className={`${FRAME} animate-pulse bg-[var(--hover)]`} />
  );
}
