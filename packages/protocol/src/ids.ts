import { z } from "zod";

/** A session's id: pi's session id, or the id of a draft that has no file yet. */
export const SessionId = z.string().min(1).max(128);

/** A project's id: opaque, never derived from its path (domain-model §1). */
export const ProjectId = z.string().regex(/^prj_[0-9a-f]{16}$/);
export type ProjectId = z.infer<typeof ProjectId>;

/** A workspace's id: opaque, never derived from its directory (domain-model §1). */
export const WorkspaceId = z.string().regex(/^wks_[0-9a-f]{16}$/);
export type WorkspaceId = z.infer<typeof WorkspaceId>;

/**
 * A chat's id: `cht_` and the name of its directory under `~/.atrium/chats/` (domain-model §1, Chat).
 *
 * @remarks
 * Atrium names the directory at random, so the id is as stable as the directory (ADR-0007).
 */
export const ChatId = z.string().regex(/^cht_[0-9A-Za-z-]{1,64}$/);
export type ChatId = z.infer<typeof ChatId>;

/** Where a session lives: a workspace, or a chat. */
export const ContainerId = z.union([WorkspaceId, ChatId]);
export type ContainerId = z.infer<typeof ContainerId>;

/**
 * Whether a container is a chat rather than a workspace.
 *
 * @remarks
 * Chats have no git and share the models of Atrium's own directory (SPEC-0001, "侧栏 · 对话").
 *
 * @sideEffects none
 * @param containerId - The container.
 * @returns Whether it is a chat.
 */
export function isChatId(containerId: string): containerId is ChatId {
  return ChatId.safeParse(containerId).success;
}
