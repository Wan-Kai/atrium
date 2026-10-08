import { z } from "zod";

/** A session's id: pi's session id, or the id of a draft that has no file yet. */
export const SessionId = z.string().min(1).max(128);

/** A project's id: opaque, never derived from its path (domain-model §1). */
export const ProjectId = z.string().regex(/^prj_[0-9a-f]{16}$/);
export type ProjectId = z.infer<typeof ProjectId>;

/** A workspace's id: opaque, never derived from its directory (domain-model §1). */
export const WorkspaceId = z.string().regex(/^wks_[0-9a-f]{16}$/);
export type WorkspaceId = z.infer<typeof WorkspaceId>;

/** The id of the chats' container, which is not a workspace (domain-model §1, ChatSpace). */
export const CHATS = "chats";

/** Where a session lives: a workspace, or the chats. */
export const ContainerId = z.union([WorkspaceId, z.literal(CHATS)]);
export type ContainerId = z.infer<typeof ContainerId>;
