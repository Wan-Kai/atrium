import { CommandError } from "@atrium/client";
import type { FileCandidate, SlashCommand } from "@atrium/protocol";
import {
  ArrowUp,
  ArrowsInSimple,
  ArrowsOutSimple,
  At,
  File,
  Folder,
  Image as ImageIcon,
  Plus,
  Square,
  Terminal,
  TextAlignLeft,
  X,
} from "@phosphor-icons/react";
import {
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { type Draft, type KeptImage } from "../state/drafts";
import { pageDrafts, useDraft } from "../state/use-draft";
import {
  type DraftText,
  type Mention,
  acceptCommand,
  composeMessage,
  droppedReference,
  enterDirectory,
  filterCommands,
  isLongPaste,
  lineCount,
  mentionAt,
  removeMention,
  slashQuery,
} from "./composer-text";
import { type CompressedImage, ImageTooLargeError, compressImage } from "./images";

const EMPTY_DRAFT: Draft = { text: "", pastes: [], files: [], images: [] };

/** An image sent with a message: its upload and the image itself, to upload again if needed. */
export interface SentImage {
  readonly attachmentId: string;
  readonly image: CompressedImage;
}

/** Props of {@link Composer}. */
export interface ComposerProps {
  /** Sends a message with its images; while a run goes on, the host queues it. */
  readonly onSend: (text: string, images: readonly SentImage[]) => void;
  /** Sends a steer (⌘+Enter); without it ⌘+Enter sends as Enter does. */
  readonly onSteer?: (text: string, images: readonly SentImage[]) => void;
  /** Stops the run (the button while running, and Esc). */
  readonly onStop?: () => void;
  /** Whether a run goes on: the button stops, Enter queues and ⌘+Enter steers. */
  readonly running?: boolean;
  /** Whether a stop waits for pi to confirm. */
  readonly stopping?: boolean;
  /** What floats above the box: the capsule bar and its panels. */
  readonly above?: ReactNode;
  /** The model button, beside the send button. */
  readonly picker?: ReactNode;
  /** Where the draft is kept: the session id, or `new:<container>` before the session exists. */
  readonly draftKey: string;
  /** The messages sent earlier, newest first, for ↑. */
  readonly history?: readonly string[];
  /** ↑ reached the oldest message loaded: load older turns. */
  readonly onOlderHistory?: () => void;
  /** pi's commands, for `/`. */
  readonly onListCommands?: () => Promise<readonly SlashCommand[]>;
  /** Files and directories for `@`. */
  readonly onSearchFiles?: (query: string) => Promise<readonly FileCandidate[]>;
  /** Uploads an image, resolving with its attachment id; without it images cannot be added. */
  readonly onUpload?: (image: CompressedImage) => Promise<string>;
  /** Whether the model takes images; `false` refuses them with a note. */
  readonly imagesAllowed?: boolean;
  /** The session's directory, which dropped files are referenced from. */
  readonly baseDir?: string | null;
  /** A dropped file's path, which only the desktop shell can tell. */
  readonly pathForFile?: (file: File) => string | null;
  /** Takes the focus when it appears, with the caret after the draft. */
  readonly autoFocus?: boolean;
  /** Compresses an image before it uploads; `compressImage` unless a test holds it back. */
  readonly compress?: (image: Blob) => Promise<CompressedImage>;
  /** The user changed the text, the pasted texts or the files: the empty state creates its session. */
  readonly onEdit?: () => void;
}

/**
 * Why an image could not be added, in Chinese.
 *
 * @remarks
 * See `Composer`.
 *
 * @sideEffects none
 * @param error - What compressing or uploading threw.
 * @returns The note to show.
 */
function imageFailure(error: unknown): string {
  if (error instanceof ImageTooLargeError) return "图片太大了，压缩后还是放不下";
  if (error instanceof CommandError && error.code === "attachment_limit")
    return "图片太多了：一次最多 20 张、共 32 MiB";
  if (error instanceof CommandError) return "图片没能上传";
  return "读不了这张图片";
}

/** What the `/` list shows. */
type CommandList = readonly SlashCommand[] | "loading" | "failed";
/** What the `@` list shows: the last answer and the query it was for, or why there is none. */
type FileList = { readonly query: string; readonly files: readonly FileCandidate[] } | "fd_missing" | "failed";

/** How each kind of command is labelled in the `/` list. */
const SOURCE_NAMES: Readonly<Record<SlashCommand["source"], string>> = {
  extension: "扩展",
  prompt: "模板",
  skill: "技能",
};

/**
 * The input box: type a message, Enter sends it, Shift+Enter starts a new line.
 *
 * @remarks
 * SPEC-0001 ("输入框", "运行中输入", "模型与输入框"): a rounded 22 card with 14 px padding;
 * Enter while an input method is composing only picks a candidate. While a run goes on the
 * button is "停止" and Esc stops too; Enter queues and ⌘+Enter steers; while a stop waits for pi
 * nothing is sent and the text stays.
 *
 * `/` at the start lists pi's commands, asked for each time the list opens; `@` lists files and
 * directories as you type, and the one chosen becomes a capsule above the text, Tab going into a
 * directory instead. ↑ ↓ move through a list, Enter or Tab choose, Esc closes it. A paste of
 * more than 8 lines or 800 characters becomes a capsule too. The message goes out as the text,
 * then the pasted texts, then the files as `@path` (`composeMessage`). In an empty box ↑ goes back
 * through the messages sent earlier and ↓ forward, while nothing at all is in the box. The draft
 * is the page's (`pageDrafts`), kept per session, so it outlives the box: an image that finishes
 * uploading after the tab went away is there when it comes back, and nothing goes while an image is
 * still compressed or uploaded. A file found for an earlier query is not chosen while the new
 * query's answer is on its way. The bottom bar has the "+" menu on the left and the model button and the send button on
 * the right; the button at the top right opens the box tall.
 *
 * @sideEffects Calls the handlers as the user acts; reads and writes the draft in storage; asks
 * for commands and files while their lists are open.
 * @param props - What to do with a message, a steer and a stop, the run's state, what floats
 * above, the model button, the draft's key, the history, where commands and files come from, and
 * whom to tell of an edit.
 * @returns The input box.
 */
export function Composer({
  onSend,
  onSteer,
  onStop,
  running = false,
  stopping = false,
  above,
  picker,
  draftKey,
  history = [],
  onOlderHistory,
  onListCommands,
  onSearchFiles,
  onUpload,
  imagesAllowed = true,
  baseDir = null,
  pathForFile,
  autoFocus = false,
  compress = compressImage,
  onEdit,
}: ComposerProps) {
  const drafts = pageDrafts();
  const { text, pastes, files, images } = useDraft(draftKey);
  /**
   * Changes part of the draft.
   *
   * @remarks
   * The draft is the page's, so every box showing it changes too. Only the user's own edits come
   * here, so `onEdit` hears of each.
   *
   * @sideEffects Updates the draft; calls `onEdit`.
   * @param part - The parts to change.
   */
  const change = (part: Partial<Draft>): void => {
    drafts.update(draftKey, (draft) => ({ ...draft, ...part }));
    onEdit?.();
  };
  /**
   * Puts new text in the draft.
   *
   * @remarks
   * See `change`.
   *
   * @sideEffects Updates the draft.
   * @param next - The text.
   */
  const setText = (next: string): void => change({ text: next });
  /**
   * Puts new pasted texts in the draft.
   *
   * @remarks
   * See `change`.
   *
   * @sideEffects Updates the draft.
   * @param next - The pasted texts.
   */
  const setPastes = (next: DraftText["pastes"]): void => change({ pastes: next });
  /**
   * Puts new file references in the draft.
   *
   * @remarks
   * See `change`.
   *
   * @sideEffects Updates the draft.
   * @param next - The files.
   */
  const setFiles = (next: DraftText["files"]): void => change({ files: next });
  const [caret, setCaret] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [browsing, setBrowsing] = useState<number | null>(null);
  /** The text a list was closed at with Esc; the list stays closed until the text changes. */
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const [commands, setCommands] = useState<CommandList | null>(null);
  const [found, setFound] = useState<FileList | null>(null);
  const [plusOpen, setPlusOpen] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const imageInput = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  /** Where the caret goes once the text just set has rendered. */
  const pendingCaret = useRef<number | null>(null);
  const listId = useId();

  const commandQuery = onListCommands === undefined ? null : slashQuery(text, caret);
  const mention = commandQuery === null && onSearchFiles !== undefined ? mentionAt(text, caret) : null;
  const listOpen = dismissed !== text && (commandQuery !== null || mention !== null);
  const message = composeMessage({ text, pastes, files });
  const uploading = images.some((image) => image.attachmentId === null);
  const empty = message === "" && images.length === 0;

  useLayoutEffect(() => {
    const at = pendingCaret.current;
    if (at === null) return;
    pendingCaret.current = null;
    box.current?.setSelectionRange(at, at);
    box.current?.focus();
  });

  useEffect(() => {
    if (!autoFocus) return;
    // The words handed over from the empty state go on where they stopped.
    pendingCaret.current = text.length;
    // oxlint-disable-next-line react-hooks-js/set-state-in-effect -- once, as the box appears.
    setCaret(text.length);
    // Only as the box appears.
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- see above.
  }, [autoFocus]);

  /**
   * Compresses and uploads images, showing each at once, its picture once compressed.
   *
   * @remarks
   * Only when the model takes images (SPEC-0001, "图片"); one that cannot be compressed or
   * uploaded goes again, with a note why. Each image is changed in the draft by its id, so the
   * result lands even when the box has gone or its draft was handed over meanwhile.
   *
   * @sideEffects Updates the draft's images; uploads through `onUpload`.
   * @param added - The image files.
   */
  const addImages = (added: readonly Blob[]): void => {
    if (added.length === 0 || onUpload === undefined) return;
    if (!imagesAllowed) {
      setNote("当前模型不支持图片");
      return;
    }
    setNote(null);
    for (const file of added) {
      const id = crypto.randomUUID();
      const pending: KeptImage = { id, image: null, attachmentId: null };
      drafts.update(draftKey, (draft) => ({ ...draft, images: [...draft.images, pending] }));
      // Fire and forget: each image reports its own failure in the note.
      void (async () => {
        try {
          const image = await compress(file);
          drafts.updateImage(id, (one) => ({ ...one, image }));
          const attachmentId = await onUpload(image);
          drafts.updateImage(id, (one) => ({ ...one, attachmentId }));
        } catch (error) {
          drafts.updateImage(id, () => null);
          setNote(imageFailure(error));
        }
      })();
    }
  };

  /**
   * References dropped files that are not images, from the session's directory when inside it.
   *
   * @remarks
   * Only the desktop shell knows a dropped file's path; without one the file is skipped. A
   * directory ends in `/` (`droppedReference`).
   *
   * @sideEffects Updates the capsules.
   * @param dropped - The files, and whether each is a directory.
   */
  const referFiles = (dropped: readonly { readonly file: File; readonly directory: boolean }[]): void => {
    const paths = dropped.flatMap(({ file, directory }) => {
      const path = pathForFile?.(file) ?? null;
      return path === null ? [] : [droppedReference(path, baseDir, directory)];
    });
    setFiles([...files, ...paths.filter((path) => !files.includes(path))]);
  };

  /**
   * Takes dropped files: images as images, the rest as references.
   *
   * @remarks
   * SPEC-0001 ("输入框"): dragging files onto the box.
   *
   * @sideEffects Adds images and capsules.
   * @param event - The drop.
   */
  const onDrop = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault();
    setDragging(false);
    const dropped = [...event.dataTransfer.files];
    // Only the drop's entries tell a directory from a file; its file entries line up with its files.
    const directories = [...event.dataTransfer.items]
      .filter((item) => item.kind === "file")
      .map((item) => item.webkitGetAsEntry()?.isDirectory === true);
    addImages(dropped.filter((file) => file.type.startsWith("image/")));
    referFiles(
      dropped.flatMap((file, at) =>
        file.type.startsWith("image/") ? [] : [{ file, directory: directories[at] ?? false }],
      ),
    );
  };

  const listingCommands = commandQuery !== null && dismissed !== text;
  useEffect(() => {
    if (!listingCommands || onListCommands === undefined) return undefined;
    let current = true;
    setCommands("loading");
    onListCommands().then(
      (listed) => current && setCommands(listed),
      () => current && setCommands("failed"),
    );
    return () => {
      current = false;
    };
    // Asked once each time the list opens, not on every key typed in it.
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- see above.
  }, [listingCommands]);

  const fileQuery = mention !== null && dismissed !== text ? mention.query : null;
  useEffect(() => {
    if (fileQuery === null || onSearchFiles === undefined) return undefined;
    let current = true;
    onSearchFiles(fileQuery).then(
      (listed) => current && setFound({ query: fileQuery, files: listed }),
      (error: unknown) =>
        current && setFound(error instanceof CommandError && error.code === "fd_missing" ? "fd_missing" : "failed"),
    );
    return () => {
      current = false;
    };
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- only a new query asks again.
  }, [fileQuery]);

  const commandItems = commandQuery !== null && Array.isArray(commands) ? filterCommands(commands, commandQuery) : [];
  const fileItems = mention !== null && typeof found === "object" && found !== null ? found.files : [];
  /** The files shown were found for what is typed now, not for an earlier query. */
  const filesFresh = mention !== null && typeof found === "object" && found !== null && found.query === mention.query;
  const itemCount = commandQuery !== null ? commandItems.length : fileItems.length;
  const highlighted = Math.min(active, Math.max(0, itemCount - 1));

  /**
   * Puts new text in the box with the caret at a place.
   *
   * @remarks
   * The caret moves once the text has rendered.
   *
   * @sideEffects Updates the text; moves the caret.
   * @param next - The text.
   * @param at - Where the caret goes.
   */
  const place = (next: string, at: number): void => {
    pendingCaret.current = at;
    setText(next);
    setCaret(at);
    setActive(0);
  };

  /**
   * Chooses the highlighted command or file.
   *
   * @remarks
   * A command takes the first word's place; a file becomes a capsule; `into` goes into a
   * directory instead of choosing it.
   *
   * @sideEffects Updates the text and the capsules.
   * @param into - Whether to go into a directory (Tab).
   */
  const choose = (into: boolean): void => {
    if (commandQuery !== null) {
      const command = commandItems[highlighted];
      if (command === undefined) return;
      const accepted = acceptCommand(text, command.name);
      place(accepted.text, accepted.caret);
      setDismissed(accepted.text);
      return;
    }
    const file = fileItems[highlighted];
    if (file === undefined || mention === null || !filesFresh) return;
    if (into && file.directory) {
      const entered = enterDirectory(text, mention, file.path);
      place(entered.text, entered.caret);
      return;
    }
    refer(mention, file.path);
  };

  /**
   * Makes a file a capsule and takes its `@` word out of the text.
   *
   * @remarks
   * The same file is referenced once.
   *
   * @sideEffects Updates the text and the capsules.
   * @param word - The `@` word.
   * @param path - The file.
   */
  const refer = (word: Mention, path: string): void => {
    const removed = removeMention(text, word);
    place(removed.text, removed.caret);
    setFiles(files.includes(path) ? files : [...files, path]);
  };

  /**
   * Sends the message or a steer, unless there is nothing, and clears the box.
   *
   * @remarks
   * Shared by the keys and the send button.
   *
   * @sideEffects Calls `onSend` or `onSteer`; clears the box and the capsules.
   * @param steer - Whether to send it as a steer.
   */
  const send = (steer: boolean): void => {
    // A message sent while a stop waits for pi would be refused; the text stays to send later.
    if (empty || stopping || uploading) return;
    const sent = images.flatMap((one) =>
      one.attachmentId === null || one.image === null ? [] : [{ attachmentId: one.attachmentId, image: one.image }],
    );
    (steer ? (onSteer ?? onSend) : onSend)(message, sent);
    drafts.update(draftKey, () => EMPTY_DRAFT);
    setNote(null);
    setBrowsing(null);
  };

  /**
   * Shows an earlier or later message from the history.
   *
   * @remarks
   * Past the newest goes back to an empty box; reaching the oldest loaded asks for older turns.
   *
   * @sideEffects Updates the text; may call `onOlderHistory`.
   * @param index - Which message, 0 the newest; -1 for none.
   */
  const browse = (index: number): void => {
    if (index < 0) {
      setBrowsing(null);
      place("", 0);
      return;
    }
    const earlier = history[index];
    if (earlier === undefined) return;
    setBrowsing(index);
    place(earlier, earlier.length);
    if (index === history.length - 1) onOlderHistory?.();
  };

  /**
   * Handles the keys: lists first, then stop, history and send.
   *
   * @remarks
   * See `Composer`.
   *
   * @sideEffects May choose, close a list, stop, browse or send.
   * @param event - The key event.
   */
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.nativeEvent.isComposing) return;
    if (listOpen) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        setActive(Math.max(0, Math.min(itemCount - 1, highlighted + step)));
        return;
      }
      // A command typed whole needs no choosing, and nothing to choose yet is no reason to wait:
      // Enter sends either way.
      const typedWhole = commandQuery !== null && commandItems[highlighted]?.name === commandQuery;
      const sends = event.key === "Enter" && (typedWhole || itemCount === 0);
      if (((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") && !sends) {
        event.preventDefault();
        choose(event.key === "Tab");
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setDismissed(text);
        return;
      }
    }
    if (event.key === "Escape" && running && !stopping) {
      event.preventDefault();
      onStop?.();
      return;
    }
    if (event.key === "ArrowUp" && (empty || browsing !== null)) {
      event.preventDefault();
      browse((browsing ?? -1) + 1);
      return;
    }
    if (event.key === "ArrowDown" && browsing !== null) {
      event.preventDefault();
      browse(browsing - 1);
      return;
    }
    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    send(event.metaKey);
  };

  /**
   * Collects a long paste into a capsule.
   *
   * @remarks
   * Short pastes go into the text as usual.
   *
   * @sideEffects May add a capsule instead of pasting.
   * @param event - The paste.
   */
  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>): void => {
    const pastedImages = [...event.clipboardData.files].filter((file) => file.type.startsWith("image/"));
    if (pastedImages.length > 0) {
      event.preventDefault();
      addImages(pastedImages);
      return;
    }
    const pasted = event.clipboardData.getData("text/plain");
    if (!isLongPaste(pasted)) return;
    event.preventDefault();
    setPastes([...pastes, { id: crypto.randomUUID(), text: pasted }]);
  };

  /**
   * Starts a reference or a command from the "+" menu.
   *
   * @remarks
   * `@` goes in at the caret, after a space when needed; `/` at the start.
   *
   * @sideEffects Updates the text; focuses the box; closes the menu.
   * @param what - What to start.
   */
  const insert = (what: "@" | "/"): void => {
    setPlusOpen(false);
    setDismissed(null);
    if (what === "/") {
      place(text.startsWith("/") ? text : `/${text}`, 1);
      return;
    }
    const before = text.slice(0, caret);
    const word = before === "" || /\s$/.test(before) ? "@" : " @";
    place(before + word + text.slice(caret), caret + word.length);
  };

  return (
    <div className="mx-auto w-full max-w-[720px] px-6 pb-1">
      <div className="relative">
        {above}
        {listOpen ? (
          <SuggestionList
            id={listId}
            kind={commandQuery === null ? "file" : "command"}
            commands={commandQuery === null ? null : commands === null ? "loading" : commands}
            commandItems={commandItems}
            files={found}
            fileItems={fileItems}
            highlighted={highlighted}
            onPick={(index, into) => {
              setActive(index);
              // The click happens before the highlight renders, so choose by index.
              if (commandQuery !== null) {
                const command = commandItems[index];
                if (command !== undefined) {
                  const accepted = acceptCommand(text, command.name);
                  place(accepted.text, accepted.caret);
                  setDismissed(accepted.text);
                }
              } else {
                const file = fileItems[index];
                if (file !== undefined && mention !== null && filesFresh) {
                  if (into && file.directory) {
                    const entered = enterDirectory(text, mention, file.path);
                    place(entered.text, entered.caret);
                  } else {
                    refer(mention, file.path);
                  }
                }
              }
            }}
          />
        ) : null}
        <div
          data-testid="composer-card"
          data-dragging={dragging ? "" : undefined}
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={(event) => {
            if (!(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))) {
              setDragging(false);
            }
          }}
          onDrop={onDrop}
          className="relative flex flex-col gap-[10px] rounded-[var(--r-bubble)] bg-[var(--surface-1)] p-[14px] shadow-[inset_0_0_0_0.5px_var(--line),0_9px_27px_rgba(41,70,122,0.08)] data-dragging:shadow-[inset_0_0_0_1.5px_var(--accent),0_9px_27px_rgba(41,70,122,0.08)]"
        >
          {dragging ? (
            <p className="pointer-events-none absolute inset-x-0 -top-7 text-center text-[length:var(--fs-sm)] text-[var(--accent)]">
              松开以添加图片或引用文件
            </p>
          ) : null}
          {note === null ? null : (
            <p role="status" className="text-[length:var(--fs-sm)] text-[var(--danger)]">
              {note}
            </p>
          )}
          {images.length > 0 && !imagesAllowed && note === null ? (
            // The model changed after the images were added; they still go, as pi shows the model a note instead.
            <p role="status" className="text-[length:var(--fs-sm)] text-[var(--attn-text)]">
              当前模型不支持图片，发出后模型看不到它们
            </p>
          ) : null}
          {images.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {images.map((one, index) => (
                <span key={one.id} className="relative">
                  {one.image === null ? (
                    <span
                      role="img"
                      aria-label={`图片 ${index + 1} 正在处理`}
                      className="block size-14 animate-pulse rounded-[var(--r-md)] bg-[var(--hover)] shadow-[0_0_0_0.5px_var(--line)]"
                    />
                  ) : (
                    <img
                      src={one.image.preview}
                      alt={`图片 ${index + 1}`}
                      className={`size-14 rounded-[var(--r-md)] object-cover shadow-[0_0_0_0.5px_var(--line)] ${
                        one.attachmentId === null ? "opacity-50" : ""
                      }`}
                    />
                  )}
                  <button
                    type="button"
                    aria-label={`移除 图片 ${index + 1}`}
                    onClick={() => drafts.updateImage(one.id, () => null)}
                    className="absolute -top-1.5 -right-1.5 rounded-full bg-[var(--surface-1)] p-0.5 text-[var(--text-dim)] shadow-[0_0_0_0.5px_var(--line)] hover:text-[var(--text)]"
                  >
                    <X size={10} />
                  </button>
                </span>
              ))}
            </div>
          ) : null}
          {files.length > 0 || pastes.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {files.map((path) => (
                <Capsule
                  key={path}
                  icon={path.endsWith("/") ? <Folder size={13} /> : <File size={13} />}
                  label={path}
                  onRemove={() => setFiles(files.filter((file) => file !== path))}
                />
              ))}
              {pastes.map((paste) => (
                <Capsule
                  key={paste.id}
                  icon={<TextAlignLeft size={13} />}
                  label={`粘贴内容 · ${lineCount(paste.text)} 行`}
                  title={paste.text.slice(0, 400)}
                  onRemove={() => setPastes(pastes.filter((other) => other.id !== paste.id))}
                />
              ))}
            </div>
          ) : null}
          <div className="relative px-1.5">
            <textarea
              ref={box}
              aria-label="消息"
              aria-controls={listOpen ? listId : undefined}
              aria-activedescendant={listOpen && itemCount > 0 ? `${listId}-${highlighted}` : undefined}
              rows={1}
              value={text}
              placeholder="发消息或描述任务，@ 引用文件，/ 使用命令"
              onChange={(event) => {
                setText(event.target.value);
                setCaret(event.target.selectionStart);
                setBrowsing(null);
                setActive(0);
              }}
              onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
              onKeyDown={onKeyDown}
              onPaste={onPaste}
              className={`w-full resize-none bg-transparent pr-7 text-[var(--text)] outline-none placeholder:text-[var(--text-dim)] ${
                expanded ? "h-[40vh]" : "max-h-60 min-h-6 [field-sizing:content]"
              }`}
            />
            <button
              type="button"
              aria-label={expanded ? "收起输入框" : "展开输入框"}
              title={expanded ? "收起输入框" : "展开输入框"}
              onClick={() => setExpanded(!expanded)}
              className="absolute top-0 right-1.5 rounded-[var(--r-sm)] p-1 text-[var(--text-dim)] hover:bg-[var(--hover)] hover:text-[var(--text-2)]"
            >
              {expanded ? <ArrowsInSimple size={14} /> : <ArrowsOutSimple size={14} />}
            </button>
          </div>
          <div className="flex items-center justify-between gap-2">
            <div className="relative">
              <input
                ref={imageInput}
                type="file"
                accept="image/*"
                multiple
                aria-label="选择图片"
                className="sr-only"
                tabIndex={-1}
                onChange={(event) => {
                  addImages([...(event.target.files ?? [])]);
                  event.target.value = "";
                }}
              />
              <button
                type="button"
                aria-label="添加"
                aria-expanded={plusOpen}
                onClick={() => setPlusOpen(!plusOpen)}
                className="flex size-8 items-center justify-center rounded-full text-[var(--text-muted)] shadow-[inset_0_0_0_1px_var(--line)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
              >
                <Plus size={15} className={`transition-transform duration-200 ${plusOpen ? "rotate-45" : ""}`} />
              </button>
              {plusOpen ? (
                <div
                  role="menu"
                  className="absolute bottom-full left-0 z-30 mb-2 min-w-44 rounded-[var(--r-btn)] bg-[var(--surface-1)] p-1 shadow-[var(--float-shadow)]"
                >
                  {onUpload === undefined ? null : (
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setPlusOpen(false);
                        if (imagesAllowed) imageInput.current?.click();
                        else setNote("当前模型不支持图片");
                      }}
                      className={MENU_ITEM}
                    >
                      <ImageIcon size={14} />
                      添加图片
                    </button>
                  )}
                  <button type="button" role="menuitem" onClick={() => insert("@")} className={MENU_ITEM}>
                    <At size={14} />
                    引用文件或目录
                  </button>
                  <button type="button" role="menuitem" onClick={() => insert("/")} className={MENU_ITEM}>
                    <Terminal size={14} />
                    命令
                  </button>
                </div>
              ) : null}
            </div>
            <div className="flex items-center gap-2">
              {picker}
              {running ? (
                <button
                  type="button"
                  aria-label={stopping ? "停止中" : "停止"}
                  disabled={stopping}
                  onClick={() => onStop?.()}
                  className="flex size-8 shrink-0 items-center justify-center rounded-full bg-[var(--text)] text-[var(--main)] disabled:opacity-50"
                >
                  <Square size={12} weight="fill" />
                </button>
              ) : (
                <button
                  type="button"
                  aria-label="发送"
                  disabled={empty || stopping || uploading}
                  onClick={() => send(false)}
                  className="flex size-8 shrink-0 items-center justify-center rounded-full bg-[var(--text)] text-[var(--main)] disabled:bg-[var(--surface-3)] disabled:text-[var(--text-dim)]"
                >
                  <ArrowUp size={16} weight="bold" />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
      {running ? (
        <p className="mt-1.5 text-center text-[length:var(--fs-sm)] text-[var(--text-dim)]">
          {stopping ? "正在停止…" : "回车排队 · ⌘回车插话 · Esc 停止"}
        </p>
      ) : null}
    </div>
  );
}

/** The class of an item in the "+" menu. */
const MENU_ITEM =
  "flex w-full items-center gap-2 rounded-[var(--r)] px-2.5 py-1.5 text-left text-[length:var(--fs-meta)] text-[var(--text-2)] hover:bg-[var(--hover)]";

/**
 * A capsule above the text: a referenced file or a pasted text, with a way to remove it.
 *
 * @remarks
 * Small pills, as design-language's "输入框" asks.
 *
 * @sideEffects Calls `onRemove`.
 * @param props - Its icon, label, tooltip and what removing does.
 * @returns The capsule.
 */
function Capsule({
  icon,
  label,
  title,
  onRemove,
}: {
  readonly icon: ReactNode;
  readonly label: string;
  readonly title?: string;
  readonly onRemove: () => void;
}) {
  return (
    <span
      title={title ?? label}
      className="inline-flex max-w-full items-center gap-1 rounded-[var(--r-pill)] bg-[var(--surface-2)] py-0.5 pr-1 pl-2 text-[length:var(--fs-sm)] text-[var(--text-2)]"
    >
      <span className="shrink-0 text-[var(--text-dim)]">{icon}</span>
      <span className="truncate">{label}</span>
      <button
        type="button"
        aria-label={`移除 ${label}`}
        onClick={onRemove}
        className="rounded-full p-0.5 text-[var(--text-dim)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
      >
        <X size={10} />
      </button>
    </span>
  );
}

/**
 * The list above the box while `/` or `@` is typed.
 *
 * @remarks
 * The highlighted option follows ↑ ↓ in the box, which keeps the focus; a click chooses.
 *
 * @sideEffects Calls `onPick`.
 * @param props - The list's id and kind, what it holds, which option is highlighted, and what a
 * click does.
 * @returns The list.
 */
function SuggestionList({
  id,
  kind,
  commands,
  commandItems,
  files,
  fileItems,
  highlighted,
  onPick,
}: {
  readonly id: string;
  readonly kind: "command" | "file";
  readonly commands: CommandList | null;
  readonly commandItems: readonly SlashCommand[];
  readonly files: FileList | null;
  readonly fileItems: readonly FileCandidate[];
  readonly highlighted: number;
  readonly onPick: (index: number, into: boolean) => void;
}) {
  let note: string | null = null;
  if (kind === "command") {
    if (commands === "loading") note = "正在读取命令…";
    else if (commands === "failed") note = "读不到命令列表";
    else if (commandItems.length === 0) note = "没有匹配的命令";
  } else if (files === "fd_missing") {
    note = "没有找到 fd，@ 引用文件要用它：在终端里打开一次 pi 会自动下载，或运行 brew install fd";
  } else if (files === "failed") {
    note = "读不到文件列表";
  } else if (files === null) {
    note = "正在查找…";
  } else if (fileItems.length === 0) {
    note = "没有找到文件";
  }
  const option = "flex w-full items-center gap-2 rounded-[var(--r-md)] px-2.5 py-1.5 text-left";
  return (
    <div
      id={id}
      role="listbox"
      aria-label={kind === "command" ? "命令" : "文件"}
      className="absolute bottom-full left-0 z-30 mb-2 max-h-72 w-full max-w-[520px] overflow-y-auto rounded-[var(--r-card)] bg-[var(--popover)] p-1.5 shadow-[var(--float-shadow)]"
    >
      {note === null ? (
        kind === "command" ? (
          commandItems.map((command, index) => (
            <button
              key={command.name}
              id={`${id}-${index}`}
              type="button"
              role="option"
              aria-selected={index === highlighted}
              tabIndex={-1}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => onPick(index, false)}
              className={`${option} aria-selected:bg-[var(--selected)] hover:bg-[var(--hover)]`}
            >
              <span className="font-mono text-[length:var(--fs-meta)] text-[var(--text)]">/{command.name}</span>
              <span className="rounded-[var(--r-sm)] bg-[var(--surface-2)] px-1 text-[length:var(--fs-xs)] text-[var(--text-dim)]">
                {SOURCE_NAMES[command.source]}
              </span>
              {command.description === null ? null : (
                <span className="min-w-0 flex-1 truncate text-[length:var(--fs-sm)] text-[var(--text-dim)]">
                  {command.description}
                </span>
              )}
            </button>
          ))
        ) : (
          fileItems.map((file, index) => (
            <button
              key={file.path}
              id={`${id}-${index}`}
              type="button"
              role="option"
              aria-selected={index === highlighted}
              tabIndex={-1}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => onPick(index, false)}
              className={`${option} aria-selected:bg-[var(--selected)] hover:bg-[var(--hover)]`}
            >
              <span className="text-[var(--text-dim)]">
                {file.directory ? <Folder size={14} /> : <File size={14} />}
              </span>
              <span className="truncate text-[length:var(--fs-meta)] text-[var(--text-2)]">{file.path}</span>
            </button>
          ))
        )
      ) : (
        <p className="px-2.5 py-1.5 text-[length:var(--fs-meta)] text-[var(--text-dim)]">{note}</p>
      )}
    </div>
  );
}
