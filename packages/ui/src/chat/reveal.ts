import { createContext } from "react";

/** A request to show a file's changes in the turn that made them. */
export interface RevealRequest {
  readonly turnId: string;
  readonly path: string;
  /** Counts requests, so asking for the same file again shows it again. */
  readonly serial: number;
}

/**
 * The latest request to show a file's changes, from "本会话改动".
 *
 * @remarks
 * The turn it names opens its files, opens that file and scrolls into view (SPEC-0001, "输入框").
 */
export const RevealContext = createContext<RevealRequest | null>(null);
