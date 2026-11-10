import type { GuideId } from "@atrium/pi";

/*
 * The four guides the task conversation chooses from (SPEC-0006, "附录：引导词"). Each is a passage written to the
 * agent, fixing the usual order of nodes and each node's default role and place. They are prompts for the model,
 * not text for the user (coding-standards.md, "宿主不产出给用户看的文字"); the full texts are also in the SPEC's
 * appendix, so they can be tuned at acceptance. Change a text here, raise its `version`, and change the appendix.
 */

/** One guide. */
export interface Guide {
  readonly id: GuideId;
  /** Bumped whenever the text changes, so a task records which wording its graph was made from. */
  readonly version: number;
  /** The words for the model. */
  readonly text: string;
}

/** The guide of a task whose conversation has not chosen one yet. */
export const UNCHOSEN_GUIDE = { id: "default", version: 1 } as const;

/** Agent 特性: a feature, following docs/development.md's standard flow. */
const FEATURE = [
  "【引导词 feature · Agent 特性】适用：要加或改一个功能，会动代码，值得走完整流程。",
  "节点顺序（按需求增减，但实现与验证一定分开）：",
  "1. 调研（explore，place=readonly）：读相关代码和文档，列出要改的文件、要遵守的约定、风险。小需求可以省略。",
  "2. 设计（advise，place=readonly）：需求里有看得见的界面改动、或有多个可行方案时加。给出方案和取舍，不写代码。",
  "3. 方案确认（human）：设计节点给出多个方案、要用户选时加；它的打回边（back）指向设计节点。",
  "4. 实现（work，place=workspace）：先写会失败的测试，再实现到测试通过。它不做最终验证。",
  "5. 检查（check，place=workspace）：跑测试、类型检查、代码检查，必要时跑破坏检查；只读代码，不改。必须是单独的节点，不能由实现节点代做。",
  "6. 审查（advise，place=readonly）：读 diff，对照需求逐条找问题；可以拆成几个并行的审查节点，各看一个角度。",
  "7. 验收合并（human，merge=true）：最后一个节点，只有它能带 merge；它的打回边指向实现节点。",
].join("\n");

/** 零碎修复: a small fix. */
const FIX = [
  "【引导词 fix · 零碎修复】适用：一个小问题，改动范围明确，不需要设计。",
  "节点顺序：",
  "1. 复现（explore，place=readonly）：找到问题所在，写下复现步骤和可疑的位置。",
  "2. 修复（work，place=workspace）：先写一个能复现问题的测试，让它先失败，再改到通过。",
  "3. 检查（check，place=workspace）：跑相关测试和项目的检查；只读代码，不改。必须是单独的节点，不能由修复节点代做。",
  "4. 验收合并（human，merge=true）：最后一个节点；它的打回边指向修复节点。",
].join("\n");

/** 定时修复: what a scheduled run uses. */
const SCHEDULED_FIX = [
  "【引导词 scheduled_fix · 定时修复】适用：每隔一段时间自动跑一遍的检查与修复，多数时候什么都没坏。",
  "节点顺序：",
  "1. 探查（check，place=workspace）：运行约定的检查命令，把失败的项和原因写进交接摘要；全部通过就写“无异常”。",
  "2. 修复（work，place=workspace）：只修探查节点报告的失败；探查写了“无异常”就什么都不改，直接 node_done，摘要写“无需修复”。",
  "3. 检查（check，place=workspace）：再跑同样的检查，确认失败项都好了；没有改动就写“无改动”。必须是单独的节点。",
  "4. 验收合并（human，merge=true）：最后一个节点，它的 done 里写明“没有改动时点通过即可，不会合并任何东西”；它的打回边指向修复节点。",
  "图是固定的，没有条件分支，所以没坏的那一天也会走到最后一个节点；写 done 时把这一点说清楚。",
].join("\n");

/** 调研报告: research; no work node, no worktree. */
const RESEARCH = [
  "【引导词 research · 调研报告】适用：要弄清一件事、比较方案、出一份报告，不改代码。",
  "节点顺序：",
  "1. 调查（explore 或 advise，place=readonly）：把问题按方面拆成几个并行的节点（如代码现状、文档、已有做法），各管一个方面，互相不依赖。",
  "2. 汇总（advise，place=readonly）：读所有调查节点的交接摘要，写出结论、依据、没弄清的地方；报告就写在它的交接摘要里。",
  "3. 确认（human）：用户读报告；它没有 merge，打回边指向汇总节点。",
  "不要 work 节点和 check 节点，也不要 place=workspace：这类任务不建 worktree，不属于项目的对话也能用。",
].join("\n");

/** Every guide, in the order the task conversation is shown them. */
export const GUIDES: readonly Guide[] = [
  { id: "feature", version: 1, text: FEATURE },
  { id: "fix", version: 1, text: FIX },
  { id: "scheduled_fix", version: 1, text: SCHEDULED_FIX },
  { id: "research", version: 1, text: RESEARCH },
];

/**
 * The record a task keeps of the guide its graph follows.
 *
 * @remarks
 * `task.guide` (SPEC-0006, "数据 · task.json"): the id and the version of the text it was made from.
 *
 * @sideEffects none
 * @param id - The guide.
 * @returns The id and the version.
 */
export function guideRecord(id: GuideId): { readonly id: GuideId; readonly version: number } {
  const found = GUIDES.find((guide) => guide.id === id);
  if (found === undefined) throw new Error(`no guide ${id}`);
  return { id, version: found.version };
}
