import type { AtriumClient } from "@atrium/client";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import { Clock, Flowchart, X } from "../design/icons";
import { RunningDots } from "../design/running-dots";
import type { TaskArea as TaskAreaState } from "../state/task-area";
import { TaskKindIcon, NodeStateIcon } from "./task-icons";
import { TaskList } from "./task-list";
import { TaskTab } from "./task-tab";
import { statusWords } from "./task-words";

/** The class of a tab, as the conversations' tabs have it. */
const TAB =
  "group flex h-[30px] max-w-[220px] min-w-24 shrink items-center gap-1.5 rounded-[var(--r)] pr-1 pl-2.5 text-[length:var(--fs-meta)] text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text-2)] aria-selected:bg-[var(--selected)] aria-selected:text-[var(--text)]";

/**
 * The task area's tab bar: "任务" and "定时" first, without close buttons, then a tab for each open task.
 *
 * @remarks
 * SPEC-0006 ("界面 · 入口"): its own bar, not mixed with the conversations'. A task's tab shows the task's name and a
 * small mark of how it goes (the dot matrix while it runs, the attention colour while it wants you), and closes
 * without touching the task, which goes on in the host. While the sidebar is folded the bar starts 120px in, clear of
 * the traffic lights, as the conversations' bar does.
 *
 * @sideEffects Subscribes to the area's state and the client's task list; writes the area's state when used.
 * @param props - The client, the area's state, and whether the sidebar is folded.
 * @returns The bar.
 */
function TaskTabBar({
  client,
  area,
  folded,
}: {
  readonly client: AtriumClient;
  readonly area: StoreApi<TaskAreaState>;
  readonly folded: boolean;
}) {
  const { active, tabs } = useStore(area);
  const tasks = useStore(client.tasks, (state) => state.tasks);
  return (
    <div
      data-testid="task-tab-bar"
      className={`flex h-12 shrink-0 items-center gap-1 pr-3 shadow-[inset_0_-0.5px_0_var(--line)] [transition:padding-left_240ms_cubic-bezier(.2,.8,.2,1)] [-webkit-app-region:drag] ${folded ? "pl-[120px]" : "pl-3"}`}
    >
      <div
        role="tablist"
        aria-label="任务区"
        className="flex min-w-0 items-center gap-0.5 overflow-x-auto [scrollbar-width:none] [-webkit-app-region:no-drag]"
      >
        {(
          [
            ["list", "任务", <Flowchart key="i" size={14} />],
            ["schedules", "定时", <Clock key="i" size={14} />],
          ] as const
        ).map(([tab, title, icon]) => (
          <div
            key={tab}
            role="tab"
            tabIndex={active === tab ? 0 : -1}
            aria-selected={active === tab}
            onClick={() => area.getState().activate(tab)}
            onKeyDown={(event) => {
              if (event.key === "Enter") area.getState().activate(tab);
            }}
            className={`${TAB} !min-w-0 pr-2.5`}
          >
            <span className="flex-none">{icon}</span>
            <span className="truncate">{title}</span>
          </div>
        ))}
        {tabs.map((id) => {
          const task = tasks.find((one) => one.id === id);
          const name = task === undefined || task.name === "" ? "任务" : task.name;
          const status = task === undefined ? null : statusWords(task);
          return (
            <div
              key={id}
              role="tab"
              tabIndex={active === id ? 0 : -1}
              aria-selected={active === id}
              title={name}
              onClick={() => area.getState().activate(id)}
              onKeyDown={(event) => {
                if (event.key === "Enter") area.getState().activate(id);
              }}
              className={TAB}
            >
              {status?.tone === "run" ? (
                <span className="inline-flex size-4 flex-none items-center justify-center text-[var(--tint)]">
                  <RunningDots size={14} />
                </span>
              ) : status?.tone === "attn" ? (
                <NodeStateIcon state="waiting" size={14} />
              ) : status?.tone === "danger" ? (
                <NodeStateIcon state="failed" size={14} />
              ) : (
                <TaskKindIcon scheduled={task?.scheduled ?? false} />
              )}
              <span className="min-w-0 flex-1 truncate">{name}</span>
              <button
                type="button"
                aria-label={`关闭 ${name}`}
                onClick={(event) => {
                  event.stopPropagation();
                  area.getState().closeTask(id);
                }}
                className="inline-flex size-5 shrink-0 items-center justify-center rounded-[var(--r-sm)] opacity-0 group-hover:opacity-100 group-aria-selected:opacity-100 hover:bg-[var(--hover)]"
              >
                <X size={11} />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * The "定时" tab's content: the schedules' empty state (SPEC-0006, "界面 · 定时标签"; T7).
 *
 * @remarks
 * Schedules arrive with T10; until then the tab says how they will come: from a conversation, with `/task`.
 *
 * @sideEffects none
 * @returns The empty state.
 */
function SchedulesEmpty() {
  return (
    <section aria-label="定时" className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-[860px] px-6 py-6">
        <div className="flex items-center gap-3 px-2.5">
          <h2 className="text-[length:var(--fs)] font-semibold text-[var(--text)]">定时</h2>
          <span className="rounded-[var(--r-pill)] bg-[var(--surface-2)] px-2 text-[length:var(--fs-sm)] leading-[20px] text-[var(--text-muted)] tabular-nums">
            0
          </span>
        </div>
        <p role="status" className="px-2.5 py-8 text-[length:var(--fs-meta)] text-[var(--text-dim)]">
          还没有定时规则。在对话里说清「每天几点做什么」再 /task，就生成定时规则。
        </p>
      </div>
    </section>
  );
}

/**
 * The task area: its tab bar, and under it the list, the schedules or a task, whichever tab is on top.
 *
 * @remarks
 * SPEC-0006 ("界面 · 入口"). It takes the place of the conversations' tab bar and area while it shows. Only the tab on
 * top is mounted, so one task is open on the connection at a time, and watching the task conversation does not
 * clash with another session's watch. Opening a task from the list or from a conversation's line brings its tab up.
 *
 * @sideEffects Subscribes to the area's state; the parts it holds send commands and watch.
 * @param props - The client, the area's state, whether the sidebar is folded, how to open the conversation a task
 * was made from, and the links conversations need.
 * @returns The area.
 */
export function TaskAreaView({
  client,
  area,
  folded,
  onOpenSource,
  links,
}: {
  readonly client: AtriumClient;
  readonly area: StoreApi<TaskAreaState>;
  readonly folded: boolean;
  readonly onOpenSource: (sessionId: string) => void;
  readonly links: React.ComponentProps<typeof TaskTab>["links"];
}) {
  const active = useStore(area, (state) => state.active);
  return (
    <>
      <TaskTabBar client={client} area={area} folded={folded} />
      {active === "list" ? (
        <TaskList client={client} area={area} onOpen={(taskId) => area.getState().openTask(taskId)} />
      ) : active === "schedules" ? (
        <SchedulesEmpty />
      ) : (
        <TaskTab key={active} client={client} taskId={active} onOpenSource={onOpenSource} links={links} />
      )}
    </>
  );
}
