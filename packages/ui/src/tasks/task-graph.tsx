import type { DiffStat, TaskModel, TaskNode, TaskView } from "@atrium/protocol";
import { useEffect, useId, useRef, useState } from "react";
import { useFloatingLayer } from "../design/floating-layer";
import { useHoverPresence } from "../chat/use-hover-presence";
import { NODE_HEIGHT, NODE_WIDTH, layoutGraph } from "./graph-layout";
import { NodeStateIcon } from "./task-icons";
import { FAILURE_WORDS, MERGE_BLOCK_WORDS, NODE_STATE_WORDS, WAITING_WORDS, modelWords, roleWords } from "./task-words";

/** How far the graph shrinks to fit its pane before the pane scrolls instead. */
/** How a node stands out after the graph changed: added, or changed (SPEC-0006, "界面 · 任务标签"). */
export type NodeMark = "new" | "changed";

const MIN_SCALE = 0.7;

/** The states the legend under the graph names, in order (设计稿第 5 屏). */
const LEGEND = ["pending", "running", "waiting", "passed", "held", "stopped", "failed"] as const;

/**
 * The line a hovered node adds about how it stands: why it failed, what it waits for, why it was sent back.
 *
 * @remarks
 * Only what the host sent as codes, worded here (SPEC-0006, "界面"). A node with nothing to add has none.
 *
 * @sideEffects none
 * @param node - The node.
 * @returns The line, or `null`.
 */
function standingOf(node: TaskNode): string | null {
  if (node.state === "failed" && node.failure !== null) return `失败：${FAILURE_WORDS[node.failure]}`;
  if (node.state === "waiting" && node.blocked !== null) {
    const files = node.blockedFiles?.length ?? 0;
    return `${WAITING_WORDS.merge_blocked}：${MERGE_BLOCK_WORDS[node.blocked]}${files > 0 ? `（${files} 个文件）` : ""}`;
  }
  if (node.state === "waiting" && node.waitingFor !== null) return WAITING_WORDS[node.waitingFor];
  return null;
}

/**
 * One node of the graph: its state, name, role, place and model, and on hover what it does and when it is done.
 *
 * @remarks
 * 设计稿第 4、5 屏: a model given to the node itself is blue, one it follows from the task grey and marked "继承".
 * The border is drawn while the node is selected; pressing it selects it, and the graph's blank clears the choice. The
 * card that floats beside it on hover and keyboard focus says what the node does and what counts as done, as the
 * status bar's cards do; a human node that waits for you adds the change it would merge.
 *
 * @sideEffects Follows the floating card's geometry while it is shown.
 * @param props - The node, where it is, the task's model, whether it is selected, the change stat of a human
 * node, and what pressing it does.
 * @returns The node.
 */
function GraphNode({
  node,
  x,
  y,
  taskModel,
  selected,
  stat,
  mark,
  onSelect,
  onOpenNode,
}: {
  readonly node: TaskNode;
  readonly x: number;
  readonly y: number;
  readonly taskModel: TaskModel;
  readonly selected: boolean;
  readonly stat: DiffStat | null;
  /** Whether the graph's last change added or changed this node (SPEC-0006, "T8b 定下的细节"). */
  readonly mark: NodeMark | null;
  readonly onSelect: () => void;
  readonly onOpenNode: ((node: string) => void) | undefined;
}) {
  const cardId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const { present, ...hover } = useHoverPresence(250);
  useFloatingLayer(trigger, card, { enabled: present, side: "right", align: "start", flip: true, gap: 8 });
  const standing = standingOf(node);
  return (
    <div {...hover} className="group/node absolute" style={{ left: x, top: y, width: NODE_WIDTH, height: NODE_HEIGHT }}>
      <button
        ref={trigger}
        type="button"
        data-testid="graph-node"
        data-node={node.id}
        data-state={node.state}
        data-mark={mark ?? undefined}
        aria-pressed={selected}
        aria-describedby={cardId}
        onClick={(event) => {
          event.stopPropagation();
          onSelect();
        }}
        className={`flex h-full w-full flex-col justify-center gap-0.5 rounded-[var(--r-md)] bg-[var(--surface-1)] px-2.5 text-left shadow-[var(--chip-shadow)] ${
          selected ? "!shadow-[0_0_0_1.5px_var(--tint)]" : "hover:shadow-[0_0_0_0.5px_var(--line-strong)]"
        } ${node.state === "pending" ? "opacity-80" : ""} ${mark === null ? "" : "outline-[1.5px] outline-offset-[2px] outline-[var(--tint)] outline-dashed"}`}
      >
        {mark === "new" ? (
          <span
            data-testid="graph-node-new"
            className="absolute -top-2 -right-1.5 rounded-[var(--r-sm)] bg-[var(--tint)] px-1.5 text-[length:var(--fs-xs)] leading-[16px] font-medium text-[var(--on-tint)]"
          >
            新
          </span>
        ) : null}
        <span className="flex min-w-0 items-center gap-1.5">
          <NodeStateIcon state={node.state} size={13} />
          <span className="flex-none text-[length:var(--fs-xs)] text-[var(--text-dim)] tabular-nums">{node.id}</span>
          <span className="min-w-0 flex-1 truncate text-[length:var(--fs-meta)] font-medium text-[var(--text-2)]">
            {node.name}
          </span>
        </span>
        <span className="truncate text-[length:var(--fs-xs)] text-[var(--text-dim)]">{roleWords(node)}</span>
        {node.kind === "human" ? null : (
          <span
            className={`truncate text-[length:var(--fs-xs)] ${node.model === null ? "text-[var(--text-dim)]" : "text-[var(--tint)]"}`}
            data-testid="graph-node-model"
            data-own={node.model !== null}
          >
            {node.model === null ? `继承 · ${modelWords(taskModel)}` : modelWords(node.model)}
          </span>
        )}
      </button>
      <div
        ref={card}
        role="tooltip"
        id={cardId}
        className="invisible absolute top-0 left-full z-30 ml-2 w-[280px] overflow-auto rounded-[12px] bg-[var(--surface-1)] px-3 py-2.5 opacity-0 shadow-[var(--float-shadow)] transition-[opacity,visibility] delay-100 duration-150 group-has-[:focus-visible]/node:visible group-has-[:focus-visible]/node:opacity-100 group-hover/node:visible group-hover/node:opacity-100 group-hover/node:delay-[120ms] dark:bg-[var(--surface-2)]"
      >
        <p className="text-[length:var(--fs-meta)] font-semibold text-[var(--text)]">
          {node.id} {node.name} · {NODE_STATE_WORDS[node.state]}
        </p>
        <p className="mt-1.5 text-[length:var(--fs-xs)] text-[var(--text-dim)]">做什么</p>
        <p className="text-[length:var(--fs-sm)] leading-relaxed whitespace-pre-wrap text-[var(--text-2)]">
          {node.job}
        </p>
        <p className="mt-1.5 text-[length:var(--fs-xs)] text-[var(--text-dim)]">怎样算完成</p>
        {node.done.map((line) => (
          <p key={line} className="text-[length:var(--fs-sm)] leading-relaxed text-[var(--text-2)]">
            · {line}
          </p>
        ))}
        {standing === null ? null : (
          <p className="mt-1.5 text-[length:var(--fs-sm)] text-[var(--attn-text)]">{standing}</p>
        )}
        {onOpenNode === undefined || node.sessionId === null ? null : (
          <button
            type="button"
            data-testid="graph-node-open"
            onClick={() => onOpenNode(node.id)}
            className="mt-1.5 text-[length:var(--fs-sm)] text-[var(--tint)] hover:underline"
          >
            打开节点对话 ›
          </button>
        )}
        {node.kind === "human" && stat !== null ? (
          <p className="mt-1.5 text-[length:var(--fs-sm)] text-[var(--text-muted)]" data-testid="graph-node-stat">
            改动 <span className="text-[var(--ok-text)]">+{stat.added}</span>{" "}
            <span className="text-[var(--danger)]">−{stat.removed}</span>
          </p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The task's graph, left of the task conversation (SPEC-0006, "界面 · 任务标签"; 设计稿第 4、5 屏).
 *
 * @remarks
 * Only shows: the layout is top to bottom, an in-order edge a soft line with an arrow, a send-back edge an orange
 * dashed loop on the left (the limit is two uses, which the legend says). A node with no state yet is drawn as
 * pending, so a draft graph shows too. Pressing a node outlines it, pressing the blank clears the choice; hovering
 * one floats what it does. The graph scrolls when it is larger than its pane. Nothing here changes a task. The
 * "图 vN" at the top is the version in force; a node that changed from the version before is not marked, as the host
 * keeps no earlier version for the board.
 *
 * @sideEffects none; the callback holds the selection.
 * @param props - The task, the selected node, the human node's change stat, and what choosing a node does.
 * @returns The graph.
 */
export function TaskGraph({
  task,
  selected,
  stat,
  marks,
  onSelect,
  onOpenNode,
}: {
  readonly task: Pick<TaskView, "nodes" | "edges" | "graphVersion" | "model">;
  readonly selected: string | null;
  readonly stat: DiffStat | null;
  /** The nodes the graph's last change added or changed. */
  readonly marks: ReadonlyMap<string, NodeMark>;
  readonly onSelect: (node: string | null) => void;
  /** Opens a node's conversation as a tab; without it the hover card has no link. */
  readonly onOpenNode?: (node: string) => void;
}) {
  const arrow = useId();
  // Twenty nodes lay out in microseconds, so each push of the task lays the graph out again.
  const layout = layoutGraph(
    task.nodes.map((node) => node.id),
    task.edges,
  );
  const pane = useRef<HTMLDivElement>(null);
  const [paneWidth, setPaneWidth] = useState(0);
  useEffect(() => {
    const element = pane.current;
    if (element === null) return undefined;
    const watch = new ResizeObserver(() => setPaneWidth(element.clientWidth));
    watch.observe(element);
    return () => watch.disconnect();
  }, []);
  // The whole graph fits the pane while that takes no more than shrinking to `MIN_SCALE`; below it the pane scrolls.
  const scale = paneWidth === 0 ? 1 : Math.min(1, Math.max(MIN_SCALE, paneWidth / layout.width));
  const at = new Map(layout.nodes.map((placed) => [placed.id, placed]));
  return (
    <section aria-label="任务图" className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-4 px-4 pt-2.5 pb-1 text-[length:var(--fs-xs)] text-[var(--text-dim)]">
        <span className="flex items-center gap-1.5">
          <svg width="22" height="6" aria-hidden>
            <path d="M0 3H22" stroke="var(--branch)" strokeWidth="1.5" />
          </svg>
          顺序 / 并行
        </span>
        <span className="flex items-center gap-1.5">
          <svg width="22" height="6" aria-hidden>
            <path d="M0 3H22" stroke="var(--attn)" strokeWidth="1.5" strokeDasharray="3 3" />
          </svg>
          打回（最多 2 次）
        </span>
        <span className="flex-1" />
        <span>点节点描框高亮，点空白取消</span>
      </div>
      <div
        ref={pane}
        data-testid="graph-pane"
        onClick={() => onSelect(null)}
        className="min-h-0 flex-1 overflow-auto bg-[var(--nav-bg)] shadow-[inset_0_0.5px_0_var(--line-soft)]"
      >
        <span
          data-testid="graph-version"
          className="block px-5 pt-1.5 text-[length:var(--fs-xs)] text-[var(--text-dim)]"
        >
          图 v{task.graphVersion}
        </span>
        <div className="mx-auto" style={{ width: layout.width * scale, height: (layout.height + 20) * scale }}>
          <div
            className="relative origin-top-left"
            data-testid="graph-canvas"
            data-scale={scale}
            style={{ width: layout.width, height: layout.height + 20, transform: `scale(${scale})` }}
          >
            <svg aria-hidden className="absolute inset-0 overflow-visible" width={layout.width} height={layout.height}>
              <defs>
                <marker id={arrow} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
                  <path d="M0 0L8 4L0 8z" fill="var(--branch)" />
                </marker>
                <marker
                  id={`${arrow}-back`}
                  viewBox="0 0 8 8"
                  refX="7"
                  refY="4"
                  markerWidth="7"
                  markerHeight="7"
                  orient="auto"
                >
                  <path d="M0 0L8 4L0 8z" fill="var(--attn)" />
                </marker>
              </defs>
              {layout.edges.map((edge) => (
                <g key={`${edge.from}>${edge.to}${edge.kind}`} data-testid="graph-edge" data-kind={edge.kind}>
                  <path
                    d={edge.path}
                    fill="none"
                    stroke={edge.kind === "back" ? "var(--attn)" : "var(--branch)"}
                    strokeWidth="1.5"
                    strokeDasharray={edge.kind === "back" ? "4 4" : undefined}
                    markerEnd={`url(#${edge.kind === "back" ? `${arrow}-back` : arrow})`}
                  />
                  {edge.label === null ? null : (
                    <text
                      x={edge.label.x}
                      y={edge.label.y}
                      fontSize="10"
                      fill="var(--attn-text)"
                      textAnchor="middle"
                      transform={`rotate(-90 ${edge.label.x} ${edge.label.y})`}
                    >
                      打回
                    </text>
                  )}
                </g>
              ))}
            </svg>
            {task.nodes.map((node) => {
              const place = at.get(node.id);
              return place === undefined ? null : (
                <GraphNode
                  key={node.id}
                  node={node}
                  x={place.x}
                  y={place.y}
                  taskModel={task.model}
                  selected={selected === node.id}
                  stat={stat}
                  mark={marks.get(node.id) ?? null}
                  onSelect={() => onSelect(node.id)}
                  onOpenNode={onOpenNode}
                />
              );
            })}
          </div>
        </div>
      </div>
      <ul className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2 text-[length:var(--fs-xs)] text-[var(--text-dim)]">
        {LEGEND.map((state) => (
          <li key={state} className="flex items-center gap-1.5">
            <NodeStateIcon state={state} size={12} />
            {NODE_STATE_WORDS[state]}
          </li>
        ))}
      </ul>
    </section>
  );
}
