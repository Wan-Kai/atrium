import type { Page } from "@playwright/test";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

/** The identity used throughout the two delivery regressions. */
export interface ChildIdentity {
  sessionId: string;
  taskId: string;
  name: string;
  role: string | null;
  branch: string | null;
}

/** Only the notice's identity, never its reply or other content. */
export interface ReportIdentity {
  sessionId: string | null;
  taskId: string | null;
  name: string | null;
  event: string | null;
}

/** The process evidence needed to distinguish an agent step from a turn source. */
interface StepIdentity {
  id: string | null;
  kind: string | null;
  tool: string | null;
  status: string | null;
  reports: ReportIdentity[];
  spawned: ChildIdentity | null;
}

/** A turn's public report locations; no user/assistant text is kept. */
export interface DeliveryTurn {
  sessionId: string;
  turnId: string;
  reports: ReportIdentity[];
  steps: StepIdentity[];
}

/** Reads one field. @remarks Raw protocol/file objects never leave the projection functions. @sideEffects none */
function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

/** Reads an identity/status string. @remarks Missing fields remain observable in assertions. @sideEffects none */
function text(value: unknown, key: string): string | null {
  const found = field(value, key);
  return typeof found === "string" ? found : null;
}

/** Reads an array for immediate projection. @remarks Does not retain its surrounding payload. @sideEffects none */
function list(value: unknown, key: string): unknown[] {
  const found = field(value, key);
  return Array.isArray(found) ? found : [];
}

/** Projects a report event. @remarks Excludes body, title, question and credentials. @sideEffects none */
function report(value: unknown): ReportIdentity {
  return {
    sessionId: text(value, "sessionId"),
    taskId: text(value, "taskId"),
    name: text(value, "name"),
    event: text(value, "event"),
  };
}

/** Projects a report source. @remarks Task bodies are deliberately not read. @sideEffects none */
function reports(source: unknown): ReportIdentity[] {
  return text(source, "kind") === "report" ? list(source, "events").map(report) : [];
}

/** Projects an actual spawn result. @remarks The fixture must not invent session/task IDs. @sideEffects none */
function spawn(value: unknown): ChildIdentity | null {
  const sessionId = text(value, "sessionId");
  const taskId = text(value, "taskId");
  const name = text(value, "name");
  return sessionId === null || taskId === null || name === null
    ? null
    : { sessionId, taskId, name, role: text(value, "role"), branch: text(value, "branch") };
}

/** Projects just the process fields these tests assert. @remarks No arguments or tool output is stored. @sideEffects none */
function step(value: unknown): StepIdentity {
  return {
    id: text(value, "id"),
    kind: text(value, "kind"),
    tool: text(value, "tool"),
    status: text(value, "status"),
    reports: reports(field(value, "source")),
    spawned: spawn(field(field(value, "details"), "spawned")),
  };
}

/** Reads transient JSON. @remarks Non-JSON frames are not recorded. @sideEffects none */
function parse(payload: string): unknown {
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

/**
 * Observes the real UI connection's delivery projection and navigation subscriptions.
 * @remarks No extra subscription/RPC, raw frame, header or diagnostic DOM capture is retained.
 * @sideEffects Installs two CDP listeners until close and records only identity/lifecycle metadata.
 */
export async function observeChildDelivery(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  const turns = new Map<string, DeliveryTurn>();
  const runs: { sessionId: string; runId: string | null; type: string; outcome: string | null }[] = [];
  const controls = new Map<
    string,
    { paused: string | null; deliveries: { id: string | null; state: string | null }[] }
  >();
  const seenDeliveries = new Map<string, Set<string>>();
  const deliveryClaims = new Map<string, Map<string, { fromTitle: string | null; event: string | null }>>();
  const activeRuns = new Map<string, string | null>();
  const subscriptions: string[][] = [];
  const snapshotTasks = new Map<string, string[]>();

  /** Projects a whole turn. @remarks A new snapshot replaces old partial metadata. @sideEffects Updates the turn map. */
  const whole = (sessionId: string, value: unknown): void => {
    const turnId = text(value, "id");
    if (turnId !== null)
      turns.set(`${sessionId}:${turnId}`, {
        sessionId,
        turnId,
        reports: reports(field(value, "source")),
        steps: list(value, "steps").map(step),
      });
  };
  /** Projects the queue and remembers observed IDs. @remarks Confirmed deliveries disappear from the latest queue. @sideEffects Updates identity sets. */
  const control = (sessionId: string, value: unknown): void => {
    const deliveries = list(value, "deliveries").map((item) => ({ id: text(item, "id"), state: text(item, "state") }));
    const seen = seenDeliveries.get(sessionId) ?? new Set<string>();
    for (const item of deliveries) if (item.id !== null) seen.add(item.id);
    seenDeliveries.set(sessionId, seen);
    const claims =
      deliveryClaims.get(sessionId) ?? new Map<string, { fromTitle: string | null; event: string | null }>();
    for (const item of list(value, "deliveries")) {
      const id = text(item, "id");
      if (id !== null) claims.set(id, { fromTitle: text(item, "fromTitle"), event: text(item, "event") });
    }
    deliveryClaims.set(sessionId, claims);
    controls.set(sessionId, { paused: text(value, "paused"), deliveries });
  };
  /** Records actual navigation subscriptions. @remarks Request bodies are otherwise discarded. @sideEffects Appends session IDs. */
  const sent = ({ response }: { response: { payloadData: string } }): void => {
    const value = parse(response.payloadData);
    if (text(value, "type") === "subscribe_sessions")
      subscriptions.push(list(value, "sessionIds").filter((id): id is string => typeof id === "string"));
  };
  /** Projects the necessary server events. @remarks Never exposes a raw message to assertions or artifacts. @sideEffects Updates public identity metadata. */
  const received = ({ response }: { response: { payloadData: string } }): void => {
    const value = parse(response.payloadData);
    const sessionId = text(value, "sessionId");
    if (sessionId === null) return;
    const type = text(value, "type");
    if (type === "run_started" || type === "run_settled") {
      runs.push({ sessionId, runId: text(value, "runId"), type, outcome: text(value, "outcome") });
      activeRuns.set(sessionId, type === "run_started" ? text(value, "runId") : null);
    }
    if (type === "session_snapshot") {
      // A rebuilt snapshot can have different live turn IDs: never retain superseded turns.
      for (const [key, turn] of turns) if (turn.sessionId === sessionId) turns.delete(key);
      activeRuns.set(sessionId, text(field(value, "run"), "runId"));
      const items = list(value, "items");
      for (const item of items) if (text(item, "kind") === "turn") whole(sessionId, item);
      snapshotTasks.set(
        sessionId,
        items.flatMap((item) => {
          const source = field(item, "source");
          const taskId = text(source, "taskId");
          return text(source, "kind") === "task" && taskId !== null ? [taskId] : [];
        }),
      );
      control(sessionId, field(value, "control"));
    }
    if (type === "control_updated") control(sessionId, field(value, "control"));
    if (type === "turn_started") whole(sessionId, field(value, "turn"));
    if (type !== "step_added" && type !== "step_updated") return;
    const turn = turns.get(`${sessionId}:${text(value, "turnId")}`);
    if (turn === undefined) return;
    const next = step(field(value, "step"));
    const at = turn.steps.findIndex((item) => item.id === next.id);
    if (at === -1) turn.steps.push(next);
    else turn.steps[at] = next;
  };
  cdp.on("Network.webSocketFrameSent", sent);
  cdp.on("Network.webSocketFrameReceived", received);
  try {
    await cdp.send("Network.enable");
  } catch (error) {
    cdp.off("Network.webSocketFrameSent", sent);
    cdp.off("Network.webSocketFrameReceived", received);
    try {
      await cdp.detach();
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], "delivery observer setup and detach failed", { cause: cleanup });
    }
    throw error;
  }
  return {
    turns,
    runs,
    controls,
    seenDeliveries,
    deliveryClaims,
    activeRuns,
    subscriptions,
    snapshotTasks,
    /** Releases both listeners. @remarks Does not alter host subscriptions. @sideEffects Detaches CDP. */
    async close() {
      cdp.off("Network.webSocketFrameSent", sent);
      cdp.off("Network.webSocketFrameReceived", received);
      await cdp.detach();
    },
  };
}

/**
 * Reads completion and durable report IDs only from the test-owned home/pi directory.
 * @remarks A partial trailing JSONL record is not durable evidence; no conversation body is returned.
 * @sideEffects Reads temporary session indexes and pi files.
 */
export async function readChildDeliveries(home: string, agentDir: string) {
  const index: unknown = JSON.parse(await readFile(join(home, "sessions.json"), "utf8"));
  const sessions = list(index, "sessions").map((item) => ({
    sessionId: text(item, "sessionId"),
    tasks: list(field(item, "agent"), "tasks").map((task) => ({
      taskId: text(task, "taskId"),
      state: text(task, "state"),
      replyEntry: text(task, "replyEntry"),
    })),
    deliveries: list(item, "deliveries").map((delivery) => ({
      id: text(delivery, "id"),
      from: text(delivery, "from"),
      taskId: text(delivery, "taskId"),
      event: text(delivery, "event"),
      state: text(delivery, "state"),
    })),
  }));
  const stored: {
    sessionId: string | null;
    entryId: string | null;
    deliveryIds: string[];
    events: ReportIdentity[];
  }[] = [];
  for (const file of await readdir(agentDir, { recursive: true })) {
    if (!file.endsWith(".jsonl")) continue;
    let sessionId: string | null = null;
    for (const line of (await readFile(join(agentDir, file), "utf8")).split("\n").slice(0, -1)) {
      if (line === "") continue;
      const entry: unknown = JSON.parse(line);
      if (text(entry, "type") === "session") sessionId = text(entry, "id");
      const details = field(entry, "details");
      if (
        text(entry, "type") !== "custom_message" ||
        text(entry, "customType") !== "atrium-agent" ||
        text(details, "kind") !== "report"
      )
        continue;
      stored.push({
        sessionId,
        entryId: text(entry, "id"),
        deliveryIds: list(details, "deliveries").filter((id): id is string => typeof id === "string"),
        events: reports(details),
      });
    }
  }
  return { sessions, stored };
}
