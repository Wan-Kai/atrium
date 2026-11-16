import { createContext } from "react";
import type { FileLineRange } from "../state/workspace-views";

/** Validates a workspace path without reading it and supplies its explicit click action. */
export type FileOpener = (path: string, range?: FileLineRange) => (() => void) | null;

/** The same workspace-scoped opening boundary for reply references and tool file chips.
 * @remarks Kept outside steps so Markdown never needs to import its own rendering parent.
 */
export const OpenFileContext = createContext<FileOpener | null>(null);

/**
 * Whether file references may name `..`, for the opener to resolve and bound.
 *
 * @remarks
 * Only a learning direction's Markdown preview: its notes in `notes/` link to `../visuals/`
 * (SPEC-0008, ML4, 2026-11-10). The opener resolves them and opens only what stays in the
 * direction; the host never gets a `..`.
 */
export const FileParentsContext = createContext(false);
