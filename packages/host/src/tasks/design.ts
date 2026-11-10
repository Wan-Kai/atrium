import { GUIDES } from "./guides";
import { escapeShell, quotedUser } from "./quote";

/*
 * The first message of the task conversation (SPEC-0006, "/task 与创建"). Words for the model, not for the
 * user (coding-standards.md, "宿主不产出给用户看的文字").
 */

/** The rules every graph follows, whichever guide it is made by (SPEC-0006, "改图" and "状态机"). */
const GRAPH_RULES = [
  "节点：id 用 N1、N2……（只含字母、数字、_、-，最长 32）；kind 是 agent（模型做）或 human（用户做）。",
  "agent 节点要有 name、job（做什么）、done（怎样算完成，逐条）、role；human 节点只有 name、job、done，没有 role、model、place。",
  "role：explore 和 advise 只读（读代码、跑只读命令），check 能跑任意命令但不能改文件，work 能改文件，在任务自己的 worktree 里。",
  "place：work 和 check 默认 workspace（任务的 worktree），explore 和 advise 默认 readonly；一般不用写。",
  "边：seq 是先后顺序，不能成环；back 只能从 human 节点指回它上游的节点，表示用户可以打回到那里。",
  "至少一个起点和一个终点；节点不超过 20 个；model、inputs 不用写，除非有理由。",
  "实现的节点不验证自己：验证一定放进单独的 check 节点，审查放进单独的 advise 节点。",
  "每个节点的 job 只写它自己这一步，后面节点的事不要写进去；done 要让别人能核对。",
  "merge=true 只能放在没有后继的 human 节点上，且任务要有 worktree。",
].join("\n");

/** What the design message needs to know about the task. */
export interface DesignInput {
  /** The conversation the task is made from. */
  readonly sourceSessionId: string;
  /** What the user typed after `/task`; `null` when nothing. */
  readonly scope: string | null;
  /** The task does not belong to a project: no `work` or `check` node, no worktree. */
  readonly projectless: boolean;
}

/**
 * Builds the first message of a task conversation.
 *
 * @remarks
 * It holds the source conversation's id, the scope, the four guides in full and the instruction: read the
 * source with `task_read_source`, write the summary, propose the graph by the chosen guide (naming it), then tell
 * the user in a sentence or two which guide, what the graph looks like and what is still open. The scope is the
 * user's own typing and is quoted and escaped; the source conversation's text is not here at all, the agent reads
 * it through `task_read_source`, which quotes it.
 *
 * @sideEffects none
 * @param input - The source, the scope and whether the task has a project.
 * @returns The message, wrapped in `<atrium-task-design>`.
 */
export function buildDesignPrompt(input: DesignInput): string {
  const lines: string[] = [
    "<atrium-task-design>",
    "用户把一段需求对话转成了任务。你是这个任务的任务对话：先整理需求，再按下面的引导词设计任务图，之后用户会在这里和你商量怎么改图。",
    `【来源对话】${escapeShell(input.sourceSessionId)}（用 task_read_source 读）`,
    input.scope === null
      ? "【范围】用户没有限定范围，整段对话都算。"
      : `【范围】${quotedUser("用户在 /task 后写的范围", input.scope)}`,
    input.projectless
      ? "【项目】这个任务不属于任何项目：图里不能有 work、check 节点，也不能有 place=workspace 的节点，只做调研和讨论。"
      : "【项目】这个任务属于一个项目，可以有 work、check 节点，改代码的节点在任务自己的 worktree 里。",
    "",
    "【你要做的】",
    "1. 用 task_read_source 读来源对话，分页读到最后一页。",
    "2. 用 task_set_summary 写需求摘要：目标、已定结论、约束、不做、未决问题、验收要点。只写对话里说过的；没定的放进未决问题，不要替用户定。范围里限定了的，只整理范围内的。",
    "3. 用 task_set_meta 给任务起一个简短的名字（几个字到一句话，说清做什么）。",
    "4. 从下面四套引导词里选最合适的一套，按它拆图，用 task_propose_graph 提交（guide 填它的 id）。图被拒绝时会带原因，改了再提交。",
    "5. 需求里说了要按时间重复做（每天几点、每周几、每隔几分钟）的，用 task_set_schedule 记下时间和地点（new_worktree：每次新建 worktree；local_readonly：在项目目录里只读地跑，图里不能有 work 节点）。这时任务是一条定时规则的模板：用户确认后保存规则，不会马上运行，之后每到时间会照这份摘要和图新建一个任务。不属于项目的对话不能定时。",
    "6. 最后用一两句话告诉用户：选了哪套引导词、图长什么样、还有什么未决问题。不要启动任务：启动（定时规则是保存）由用户确认。",
    "拿不准的地方用 ask_user 问用户，不要猜。",
    "",
    "【图的规则】",
    GRAPH_RULES,
    "",
    "【四套引导词】",
    ...GUIDES.map((guide) => guide.text),
    "</atrium-task-design>",
  ];
  return lines.join("\n");
}
