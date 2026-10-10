import { Appearance, DisplayMode, ModelRef, ThinkingLevel } from "@atrium/protocol";
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
});
export type WorkspaceRecord = z.infer<typeof WorkspaceRecord>;

const ProjectsDocument = z.looseObject({ projects: z.array(ProjectRecord), workspaces: z.array(WorkspaceRecord) });
export type ProjectsDocument = z.infer<typeof ProjectsDocument>;

/** `projects.json`: the registered projects and their workspaces (domain-model §1, "索引的存储"). */
export const PROJECTS_FILE: IndexFileSpec<ProjectsDocument> = {
  name: "projects",
  version: 1,
  schema: ProjectsDocument,
  empty: () => ({ projects: [], workspaces: [] }),
};

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
});
export type SessionRecord = z.infer<typeof SessionRecord>;

const SessionsDocument = z.looseObject({ sessions: z.array(SessionRecord) });
export type SessionsDocument = z.infer<typeof SessionsDocument>;

/** `sessions.json`: the sessions Atrium created or archived (domain-model §1, "索引的存储"). */
export const SESSIONS_FILE: IndexFileSpec<SessionsDocument> = {
  name: "sessions",
  version: 1,
  schema: SessionsDocument,
  empty: () => ({ sessions: [] }),
};

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

/** `layouts.json`: each client's tabs and where it is (domain-model, "已决定 4"). */
export const LAYOUTS_FILE: IndexFileSpec<LayoutsDocument> = {
  name: "layouts",
  version: 1,
  schema: LayoutsDocument,
  empty: () => ({ clients: [] }),
};

const PreferencesDocument = z.looseObject({
  appearance: Appearance,
  displayMode: DisplayMode,
  /** The model last chosen in any session; `null` until one is (SPEC-0001, "模型与输入框"). */
  lastModel: ModelRef.nullable(),
  /** Each model's last thinking level, keyed `providerId/modelId`. */
  thinkingByModel: z.record(z.string(), ThinkingLevel),
  /** The status bar groups switched from their default; absent before M1.8 (SPEC-0001, "状态栏（M1.8）"). */
  statusBar: z.record(z.string(), z.boolean()).optional(),
});
export type PreferencesDocument = z.infer<typeof PreferencesDocument>;

/** `preferences.json`: global preferences, the same for every client (domain-model §5). */
export const PREFERENCES_FILE: IndexFileSpec<PreferencesDocument> = {
  name: "preferences",
  version: 2,
  schema: PreferencesDocument,
  empty: () => ({ appearance: "system", displayMode: "summary", lastModel: null, thinkingByModel: {} }),
  migrations: {
    // M1.7 remembers models; before, none was chosen.
    1: (document) => ({ ...document, lastModel: null, thinkingByModel: {} }),
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
