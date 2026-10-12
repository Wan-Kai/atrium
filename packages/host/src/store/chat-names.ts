import type { IndexFile } from "./index-file";
import type { ChatsDocument } from "./index-schema";

/** The names the user gave chats. */
export interface ChatNames {
  /** A chat's name; `null` for none. */
  alias(chatId: string): string | null;
  /** Names a chat, or with `null` forgets its name; writes `chats.json` only when that changes it. */
  rename(chatId: string, alias: string | null): Promise<void>;
}

/**
 * Creates the chat names over `chats.json`.
 *
 * @remarks
 * A chat without a name has no record, and shows its first session's title (ADR-0007). Whether
 * the chat exists is the caller's to check: chats are found by their directories. The name of a
 * chat whose directory went stays: a few bytes, naming nothing shown.
 *
 * @sideEffects none until a change; then writes `chats.json`.
 * @param file - The loaded file.
 * @returns The names.
 */
export function createChatNames(file: IndexFile<ChatsDocument>): ChatNames {
  return {
    alias: (chatId) => file.read().chats.find((record) => record.id === chatId)?.alias ?? null,
    async rename(chatId, alias) {
      const document = file.read();
      const others = document.chats.filter((record) => record.id !== chatId);
      const before = document.chats.find((record) => record.id === chatId)?.alias ?? null;
      if (before === alias) return;
      await file.save({ ...document, chats: alias === null ? others : [...others, { id: chatId, alias }] });
    },
  };
}
