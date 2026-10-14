import { z } from "zod";

// What the right panel's file tree and the viewer tabs read of a workspace (SPEC-0001, "M1.12 的文件与更改").

/** The limits on what `list_dir` and `read_file` give. */
export const FILE_LIMITS = {
  /** The most entries one directory lists. */
  entries: 5_000,
  /** The largest text file read, in bytes. */
  textBytes: 1024 * 1024,
  /** The largest image read, in bytes. */
  imageBytes: 10 * 1024 * 1024,
  /** The longest path a command may name. */
  pathLength: 4096,
} as const;

/** A path within a workspace, `/`-separated and relative; `""` is the workspace itself. */
export const WorkspacePath = z.string().max(FILE_LIMITS.pathLength);
export type WorkspacePath = z.infer<typeof WorkspacePath>;

/** One entry of a directory; a link is reported as one, never followed. */
export const DirEntry = z.strictObject({
  name: z.string().min(1).max(1024),
  kind: z.enum(["file", "dir", "link"]),
});
export type DirEntry = z.infer<typeof DirEntry>;

/** The image formats a file is shown as itself in; none of them can carry script. */
export const ShownImageType = z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]);
export type ShownImageType = z.infer<typeof ShownImageType>;

/**
 * What a file holds, as the viewer shows it.
 *
 * @remarks
 * `too_large` is text over 1 MB or an image over 10 MB; `binary` is neither text nor one of the
 * four images; `link` is a symbolic link, whose target is not read.
 */
export const FileContent = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("text"), text: z.string().max(FILE_LIMITS.textBytes) }),
  z.strictObject({
    kind: z.literal("image"),
    mimeType: ShownImageType,
    /** Base64, without a `data:` prefix. */
    data: z
      .string()
      .min(1)
      .max(Math.ceil(FILE_LIMITS.imageBytes / 3) * 4),
  }),
  z.strictObject({ kind: z.enum(["binary", "too_large", "link"]) }),
]);
export type FileContent = z.infer<typeof FileContent>;
