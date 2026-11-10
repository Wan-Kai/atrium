import type { Chat } from "@atrium/protocol";
import type { IndexFile } from "./index-file";
import { type ChatsDocument, listedAlias } from "./index-schema";

/** How a chat was archived: when, the sessions archived with it, and its first session then. */
interface ChatArchive {
  readonly at: number;
  readonly sessions: readonly string[];
  readonly first: string | null;
}

/** What Atrium keeps of chats: the names the user gave them, which are pinned, and which are archived. */
export interface ChatRecords {
  /** A chat's name; `null` for none. */
  alias(chatId: string): string | null;
  /** Names a chat, or with `null` forgets its name; writes `chats.json` only when that changes it. */
  rename(chatId: string, alias: string | null): Promise<void>;
  /** When a chat was pinned; `null` when it is not (SPEC-0001, "对话的置顶与顺序"). */
  pinned(chatId: string): number | null;
  /**
   * Pins a chat at `at`.
   *
   * @remarks
   * An already pinned chat keeps its time, so pinning again writes nothing.
   */
  pin(chatId: string, at: number): Promise<void>;
  /** Unpins a chat; writes `chats.json` only when that changes it. */
  unpin(chatId: string): Promise<void>;
  /** How a chat was archived; `null` when it is not. */
  archived(chatId: string): ChatArchive | null;
  /** Marks a chat archived, or with `null` restored; writes `chats.json` only when that changes it. */
  setArchived(chatId: string, archive: ChatArchive | null): Promise<void>;
}

/**
 * Creates the chat records over `chats.json`.
 *
 * @remarks
 * A chat with neither a name nor an archive has no record, and shows its first session's title
 * (ADR-0007). Whether the chat exists is the caller's to check: chats are found by their
 * directories. The record of a chat whose directory went stays: a few bytes, naming nothing shown.
 *
 * @sideEffects none until a change; then writes `chats.json`.
 * @param file - The loaded file.
 * @returns The records.
 */
export function createChatRecords(file: IndexFile<ChatsDocument>): ChatRecords {
  /**
   * Changes a chat's record, dropping it when nothing is left in it.
   *
   * @remarks
   * Writes only when the record changes, so asking for what is already there writes nothing. Fields
   * of the record this Atrium does not know stay.
   *
   * @sideEffects May write `chats.json`.
   * @param chatId - The chat.
   * @param change - The fields to set; `undefined` removes one.
   */
  async function update(
    chatId: string,
    change: {
      readonly alias?: string | undefined;
      readonly archived?: ChatArchive | undefined;
      readonly pinnedAt?: number | undefined;
    },
  ): Promise<void> {
    const document = file.read();
    const before = document.chats.find((record) => record.id === chatId) ?? { id: chatId };
    const { alias, archived, pinnedAt } = { ...before, ...change };
    // Fields a newer Atrium wrote stay (`IndexFileSpec.schema`).
    const { alias: _alias, archived: _archived, pinnedAt: _pinnedAt, ...rest } = before;
    const after = {
      ...rest,
      ...(alias === undefined ? {} : { alias }),
      ...(pinnedAt === undefined ? {} : { pinnedAt }),
      ...(archived === undefined ? {} : { archived: { ...archived, sessions: [...archived.sessions] } }),
    };
    if (JSON.stringify(after) === JSON.stringify(before)) return;
    const others = document.chats.filter((record) => record.id !== chatId);
    // A record left with only its id goes; one with fields a newer Atrium wrote stays.
    const kept = Object.keys(after).length === 1 ? others : [...others, after];
    await file.save({ ...document, chats: kept });
  }

  return {
    alias: (chatId) => listedAlias(file.read().chats.find((record) => record.id === chatId)?.alias),
    rename: (chatId, alias) => update(chatId, { alias: alias ?? undefined }),
    pinned: (chatId) => file.read().chats.find((record) => record.id === chatId)?.pinnedAt ?? null,
    pin: (chatId, at) => {
      // Pinning again keeps the first time, so a pinned chat does not jump around its group.
      const already = file.read().chats.find((record) => record.id === chatId)?.pinnedAt;
      return update(chatId, { pinnedAt: already ?? at });
    },
    unpin: (chatId) => update(chatId, { pinnedAt: undefined }),
    archived: (chatId) => file.read().chats.find((record) => record.id === chatId)?.archived ?? null,
    setArchived: (chatId, archive) => update(chatId, { archived: archive ?? undefined }),
  };
}

/**
 * The chats as the list shows them: each with its name and when it was archived.
 *
 * @remarks
 * An archived chat has no session left not archived, so it is named after the first session it
 * had when archived (SPEC-0001, "M1.11 的对话归档").
 *
 * @sideEffects none
 * @param chats - The chats there are, each with its first session not archived.
 * @param records - The chats' records.
 * @returns The chats.
 */
export function listChats(
  chats: readonly { readonly id: string; readonly dir: string; readonly firstSessionId: string | null }[],
  records: Pick<ChatRecords, "alias" | "archived" | "pinned">,
): Chat[] {
  return chats.map(({ id, dir, firstSessionId }) => {
    const archive = records.archived(id);
    return {
      id,
      dir,
      alias: records.alias(id),
      firstSessionId: archive === null ? firstSessionId : archive.first,
      archivedAt: archive === null ? null : archive.at,
      pinnedAt: records.pinned(id),
    };
  });
}
