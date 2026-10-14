import { Appearance, Attention, ModelRef, ProxySetting, ThinkingLevel } from "@atrium/protocol";
import { basename } from "node:path";
import { z } from "zod";
import type { IndexFileSpec } from "./index-file";

// The formats of the index's files (domain-model §1, "索引的存储"). Objects are loose, so fields a
// newer Atrium added survive a rewrite by this one.

/** A registered project, as `projects.json` keeps it. */
const ProjectRecord = z.looseObject({
  id: z.string(),
  path: z.string(),
  name: z.string(),
  /** The user's main branch; `null` to follow `origin/HEAD`. */
  mainBranch: z.string().nullable(),
});
export type ProjectRecord = z.infer<typeof ProjectRecord>;

/** A registered workspace, as `projects.json` keeps it; branches and times are scanned, not kept. */
const WorkspaceRecord = z.looseObject({
  id: z.string(),
  projectId: z.string(),
  kind: z.enum(["local", "worktree"]),
  dir: z.string(),
  alias: z.string().nullable(),
  /** The commit Atrium created the worktree at; `null` for an external one. */
  baseCommit: z.string().nullable(),
  external: z.boolean(),
  /**
   * When it was archived, what it had checked out then and the sessions archived with it; absent
   * or `null` when it is not (SPEC-0001, "M1.11 的工作区归档"). Added without a new version: older
   * files have none, and older archives no sessions.
   */
  archived: z
    .strictObject({
      at: z.number(),
      branch: z.string().nullable(),
      head: z.string().nullable(),
      sessions: z.array(z.string()).optional(),
    })
    .nullable()
    .optional(),
});
export type WorkspaceRecord = z.infer<typeof WorkspaceRecord>;

/** How a workspace was archived, as its record keeps it. */
export type WorkspaceArchive = NonNullable<WorkspaceRecord["archived"]>;

const ProjectsDocument = z.looseObject({ projects: z.array(ProjectRecord), workspaces: z.array(WorkspaceRecord) });
export type ProjectsDocument = z.infer<typeof ProjectsDocument>;

/** `projects.json`: the registered projects and their workspaces (domain-model §1, "索引的存储"). */
export const PROJECTS_FILE: IndexFileSpec<ProjectsDocument> = {
  name: "projects",
  version: 1,
  schema: ProjectsDocument,
  empty: () => ({ projects: [], workspaces: [] }),
};

/**
 * What `chats.json` keeps of a chat: its name and whether it is archived; a chat with neither has
 * no record (ADR-0007; SPEC-0001, "M1.11 的对话归档").
 */
const ChatRecord = z.looseObject({
  id: z.string(),
  alias: z.string().optional(),
  archived: z
    .looseObject({
      at: z.number().int().nonnegative(),
      sessions: z.array(z.string()),
      first: z.string().nullable(),
    })
    .optional(),
});

const ChatsDocument = z.looseObject({ chats: z.array(ChatRecord) });
export type ChatsDocument = z.infer<typeof ChatsDocument>;

/** `chats.json`: the names given to chats and which are archived (domain-model §1, "索引的存储"). */
export const CHATS_FILE: IndexFileSpec<ChatsDocument> = {
  name: "chats",
  version: 2,
  schema: ChatsDocument,
  empty: () => ({ chats: [] }),
  migrations: {
    // M1.11 archives chats: a record may have an archive and no name, which version 1 cannot read.
    1: (document) => document,
  },
};

/** The container every chat's session was filed under in version 1 of `sessions.json`. */
const OLD_CHATS = "chats";

/** A session Atrium created or archived, as `sessions.json` keeps it. */
const SessionRecord = z.looseObject({
  sessionId: z.string(),
  /** The container it was created in (domain-model, "已决定 5"). */
  containerId: z.string(),
  /** Its working directory, to start pi in while it is a draft. */
  cwd: z.string(),
  /** No file has been found for it yet. */
  draft: z.boolean(),
  archived: z.boolean(),
  createdAt: z.number(),
  /** Why it needs a look, until its next run starts (SPEC-0001, "会话状态"); added in M1.9. */
  attention: Attention.nullable().optional(),
  /** It was handed to pi in a terminal (SPEC-0001, "交给终端"); added in M1.9. */
  handedOff: z.boolean().optional(),
  /** Fast as last switched in it (SPEC-0001, "Fast"); added in M1.11. */
  fast: z.boolean().optional(),
});
export type SessionRecord = z.infer<typeof SessionRecord>;

const SessionsDocument = z.looseObject({ sessions: z.array(SessionRecord) });
export type SessionsDocument = z.infer<typeof SessionsDocument>;

/** `sessions.json`: the sessions Atrium created or archived (domain-model §1, "索引的存储"). */
export const SESSIONS_FILE: IndexFileSpec<SessionsDocument> = {
  name: "sessions",
  version: 2,
  schema: SessionsDocument,
  empty: () => ({ sessions: [] }),
  migrations: {
    // Each chat is its own container now, named after its directory (ADR-0007).
    1: ({ sessions, ...rest }) => ({
      ...rest,
      sessions: Array.isArray(sessions) ? sessions.map(chatOfRecord) : sessions,
    }),
  },
};

/**
 * Files a version 1 session record of the chats under its own chat.
 *
 * @remarks
 * Its chat is the one of its working directory, `cht_<directory name>` (domain-model §1, "索引的存储").
 * Anything else, as a record a hand broke, is left for the schema to judge.
 *
 * @sideEffects none
 * @param record - The record.
 * @returns The record, filed under its chat.
 */
function chatOfRecord(record: unknown): unknown {
  if (typeof record !== "object" || record === null) return record;
  const containerId: unknown = Reflect.get(record, "containerId");
  const cwd: unknown = Reflect.get(record, "cwd");
  if (containerId !== OLD_CHATS || typeof cwd !== "string") return record;
  return { ...record, containerId: `cht_${basename(cwd)}` };
}

const Tabs = z.looseObject({ open: z.array(z.string()), active: z.string().nullable() });
export type TabsRecord = z.infer<typeof Tabs>;

const ClientLayout = z.looseObject({
  clientId: z.string(),
  /** When the client last did something with its layout, for pruning. */
  seenAt: z.number(),
  container: z.string().nullable(),
  tabs: z.record(z.string(), Tabs),
});
export type ClientLayout = z.infer<typeof ClientLayout>;

const LayoutsDocument = z.looseObject({ clients: z.array(ClientLayout) });
export type LayoutsDocument = z.infer<typeof LayoutsDocument>;

/**
 * `layouts.json`: each client's tabs and where it is (domain-model, "已决定 4").
 *
 * @remarks
 * Upgrading version 1 needs the sessions' containers, since the tabs of the chats go to each
 * session's own chat (domain-model §1, "索引的存储"); so `sessions.json` is loaded first.
 *
 * @sideEffects none
 * @param sessions - `sessions.json` as loaded.
 * @returns The file's spec.
 */
export function layoutsFile(sessions: SessionsDocument): IndexFileSpec<LayoutsDocument> {
  const containers = new Map(sessions.sessions.map((record) => [record.sessionId, record.containerId]));
  return {
    name: "layouts",
    version: 2,
    schema: LayoutsDocument,
    empty: () => ({ clients: [] }),
    migrations: {
      1: (document) => ({
        ...document,
        clients: Array.isArray(document["clients"])
          ? document["clients"].map((client: unknown) => splitChats(client, containers))
          : document["clients"],
      }),
    },
  };
}

/**
 * Moves a version 1 client layout's tabs of the chats to each session's own chat.
 *
 * @remarks
 * Tabs keep their order; the active tab stays active in its chat, the first tab is active in each
 * other chat, which would otherwise show nothing, and a client that was in the chats goes to the
 * active tab's chat, or nowhere without one. A tab whose session has no record, or whose
 * record is not a chat's, is dropped. Anything a hand broke is left for the schema to judge.
 *
 * @sideEffects none
 * @param client - The client's layout.
 * @param containers - Each recorded session's container.
 * @returns The layout.
 */
function splitChats(client: unknown, containers: ReadonlyMap<string, string>): unknown {
  const parsed = ClientLayout.safeParse(client);
  if (!parsed.success) return client;
  const { [OLD_CHATS]: old, ...tabs } = parsed.data.tabs;
  if (old === undefined && parsed.data.container !== OLD_CHATS) return client;
  const moved: Record<string, TabsRecord> = {};
  for (const sessionId of old?.open ?? []) {
    const chatId = containers.get(sessionId);
    if (chatId === undefined || !chatId.startsWith("cht_")) continue;
    const into = moved[chatId] ?? { open: [], active: null };
    moved[chatId] = {
      open: [...into.open, sessionId],
      active: sessionId === old?.active ? sessionId : (into.active ?? sessionId),
    };
  }
  const active = old?.active ?? null;
  const activeChat = active === null ? undefined : containers.get(active);
  const container =
    parsed.data.container !== OLD_CHATS
      ? parsed.data.container
      : activeChat !== undefined && moved[activeChat] !== undefined
        ? activeChat
        : null;
  return { ...parsed.data, container, tabs: { ...tabs, ...moved } };
}

const PreferencesDocument = z.looseObject({
  appearance: Appearance,
  /** The model last chosen in any session; `null` until one is (SPEC-0001, "模型与输入框"). */
  lastModel: ModelRef.nullable(),
  /** Each model's last thinking level, keyed `providerId/modelId`. */
  thinkingByModel: z.record(z.string(), ThinkingLevel),
  /** The status bar groups switched from their default; absent before M1.8 (SPEC-0001, "状态栏（M1.8）"). */
  statusBar: z.record(z.string(), z.boolean()).optional(),
  /** Whether first launch was gone through; absent before M1.10 (SPEC-0001, "首次启动"). */
  setupDone: z.boolean().optional(),
  /** The model that names sessions, `null` for each session's own; absent before M1.10 (SPEC-0001, "设置"). */
  titleModel: ModelRef.nullable().optional(),
  /** The network proxy, `null` for the login shell's; absent before M1.11 (SPEC-0001, "设置 · pi"). */
  proxy: ProxySetting.nullable().optional(),
  /** Fast as last switched in any session; absent before M1.11's Fast (SPEC-0001, "Fast"). */
  lastFast: z.boolean().optional(),
  /** Whether the sidebar shows "等你处理"; absent before M1.11's bottom card (SPEC-0001, "侧栏 · 收件箱"). */
  inbox: z.boolean().optional(),
});
export type PreferencesDocument = z.infer<typeof PreferencesDocument>;

/** `preferences.json`: global preferences, the same for every client (domain-model §5). */
export const PREFERENCES_FILE: IndexFileSpec<PreferencesDocument> = {
  name: "preferences",
  version: 3,
  schema: PreferencesDocument,
  empty: () => ({ appearance: "system", lastModel: null, thinkingByModel: {} }),
  migrations: {
    // M1.7 remembers models; before, none was chosen.
    1: (document) => ({ ...document, lastModel: null, thinkingByModel: {} }),
    // M1.11 took the display mode out (SPEC-0001, "过程的显示").
    2: ({ displayMode: _gone, ...document }) => document,
  },
};

const TurnStartsDocument = z.looseObject({
  entries: z.array(z.string()),
  /** The messages the host sent on its own; absent until there is one. */
  auto: z.array(z.string()).optional(),
});
export type TurnStartsDocument = z.infer<typeof TurnStartsDocument>;

/**
 * `turns/<session id>.json`: the user message entries the host saw open a turn.
 *
 * @remarks
 * pi's file does not tell a new turn from a steer (SPEC-0001, `steer`); the host records what it
 * saw so a rebuild after a restart still agrees (domain-model §1, "索引的存储").
 *
 * @sideEffects none
 * @param sessionId - The session; only ids safe as a file name.
 * @returns The file's spec.
 */
export function turnStartsFile(sessionId: string): IndexFileSpec<TurnStartsDocument> {
  return { name: `turns/${sessionId}`, version: 1, schema: TurnStartsDocument, empty: () => ({ entries: [] }) };
}
