import { createContext } from "react";
import type { FileLineRange } from "../state/workspace-views";

/** Validates a workspace path without reading it and supplies its explicit click action. */
export type FileOpener = (path: string, range?: FileLineRange) => (() => void) | null;

/** The same workspace-scoped opening boundary for reply references and tool file chips.
 * @remarks Kept outside steps so Markdown never needs to import its own rendering parent.
 */
export const OpenFileContext = createContext<FileOpener | null>(null);
