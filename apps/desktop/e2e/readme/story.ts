import type { FauxBlock, ReadmeFauxReply, ReadmeFauxScript } from "@atrium/testkit";

/** A tool call's arguments, as a scripted reply carries them. */
type Arguments = Extract<FauxBlock, { type: "toolCall" }>["arguments"];

/**
 * A scripted tool call.
 *
 * @remarks
 * Keeps the story readable: one line per call.
 *
 * @sideEffects none
 * @param id - The call's fixed id.
 * @param name - The tool.
 * @param args - Its arguments.
 * @returns The block.
 */
const call = (id: string, name: string, args: Arguments): FauxBlock => ({
  type: "toolCall",
  id,
  name,
  arguments: args,
});

/**
 * A scripted thinking block.
 *
 * @remarks
 * Keeps the story readable.
 *
 * @sideEffects none
 * @param text - What the model thinks.
 * @returns The block.
 */
const think = (text: string): FauxBlock => ({ type: "thinking", text });

/**
 * A scripted text block.
 *
 * @remarks
 * Keeps the story readable.
 *
 * @sideEffects none
 * @param text - What the model says.
 * @returns The block.
 */
const say = (text: string): FauxBlock => ({ type: "text", text });

/** What the user asks in the story: three jobs the main agent hands to three children. */
export const ASK = "给首页加上逐小时预报。顺便查查缓存会不会把过期的预报给首页，再让 GPT 看看 api.ts 的错误处理。";

/** The read-only child's task: whether the cache serves stale forecasts. */
const AUDIT_TASK =
  "查一下 src/cache.ts 的缓存什么时候失效，会不会把过期的预报返回给首页。只读代码、不要改；结论里写清楚问题在哪几行、建议怎么改。";
/** The writing child's task, in a worktree of its own: the hourly forecast. */
const HOURLY_TASK =
  "给首页加上逐小时预报：在 src/api.ts 加 fetchHourly（接口 /forecast/hourly，返回从现在起的整点预报），新建 src/components/hourly-strip.tsx 横向显示 24 小时，接到 src/pages/home.tsx 的当前温度下面，并补上测试。";
/** The advising child's task, on GPT: the error handling of `api.ts`. */
const REVIEW_TASK =
  "审一下 src/api.ts 的错误处理：网络失败、超时、返回格式不对时首页会怎样，按严重程度列出问题，不用改代码。";

/** `src/cache.ts` before the main agent's edit, as the demo commits it. */
const CACHE_OLD = `/** 按城市缓存最近一次的预报。 */
const entries = new Map<string, Forecast>();

export const cache = {
  get(city: string): Forecast | undefined {
    return entries.get(city);
  },
  set(city: string, forecast: Forecast): void {
    entries.set(city, forecast);
  },
};
`;
/** `src/cache.ts` after it: entries expire after 30 minutes. */
const CACHE_NEW = `/** 预报接口每 30 分钟更新一次，缓存和它对齐。 */
const TTL_MS = 30 * 60 * 1000;

/** 按城市缓存最近一次的预报和存入的时间。 */
const entries = new Map<string, { forecast: Forecast; savedAt: number }>();

export const cache = {
  get(city: string, now = Date.now()): Forecast | undefined {
    const entry = entries.get(city);
    if (entry === undefined) return undefined;
    if (now - entry.savedAt > TTL_MS) {
      entries.delete(city);
      return undefined;
    }
    return entry.forecast;
  },
  set(city: string, forecast: Forecast, now = Date.now()): void {
    entries.set(city, { forecast, savedAt: now });
  },
};
`;

/** The end of `src/api.ts`, where the hourly child adds `fetchHourly`. */
const API_OLD_TAIL = `  cache.set(city, forecast);
  return forecast;
}
`;
/** The end of `src/api.ts` with `fetchHourly`. */
const API_NEW_TAIL = `  cache.set(city, forecast);
  return forecast;
}

export interface HourlyForecast {
  time: string;
  temperature: number;
  condition: string;
  rainChance: number;
}

/** 从现在起的整点预报。 */
export async function fetchHourly(city: string): Promise<HourlyForecast[]> {
  const response = await fetch(\`\${BASE}/forecast/hourly?city=\${encodeURIComponent(city)}\`);
  if (!response.ok) throw new Error(\`hourly forecast failed: \${response.status}\`);
  return (await response.json()) as HourlyForecast[];
}
`;

/** The hourly strip the hourly child writes. */
const STRIP = `import type { HourlyForecast } from "../api";

/** 首页的逐小时预报：从现在起 24 个整点，横向滚动；降水概率到 30% 才标出来。 */
export function HourlyStrip({ hours }: { hours: HourlyForecast[] }) {
  return (
    <ol className="hourly-strip">
      {hours.slice(0, 24).map((hour) => (
        <li key={hour.time}>
          <time dateTime={hour.time}>{hour.time.slice(11, 16)}</time>
          <span className="condition">{hour.condition}</span>
          <strong>{Math.round(hour.temperature)}°</strong>
          {hour.rainChance >= 30 ? <small>{hour.rainChance}%</small> : null}
        </li>
      ))}
    </ol>
  );
}
`;

/** The test the hourly child writes. */
const HOURLY_TEST = `import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { HourlyStrip } from "../src/components/hourly-strip";

const hour = (time: string, rainChance: number) => ({ time, temperature: 21.4, condition: "小雨", rainChance });

it("shows 24 hours at most", () => {
  const hours = Array.from({ length: 30 }, (_, i) => hour(\`2026-10-19T\${String(i % 24).padStart(2, "0")}:00\`, 0));
  render(<HourlyStrip hours={hours} />);
  expect(screen.getAllByRole("listitem")).toHaveLength(24);
});

it("marks the rain chance from 30%", () => {
  render(<HourlyStrip hours={[hour("2026-10-19T14:00", 60), hour("2026-10-19T15:00", 10)]} />);
  expect(screen.getByText("60%")).toBeInTheDocument();
  expect(screen.queryByText("10%")).toBeNull();
});
`;

/**
 * The main agent's replies: it opens three children, waits, answers the audit's question, edits the
 * cache and sums up. The third waits for the `answer` gate, so the children list is captured while
 * the question is open.
 */
export const MAIN: readonly ReadmeFauxReply[] = [
  {
    blocks: [
      think(
        "三件事互不相干，可以并行：缓存只需要读代码；逐小时预报要改代码，放进它自己的 worktree；错误处理交给 GPT 当顾问看一遍。",
      ),
      call("spawn-audit", "agent_spawn", { name: "cache-audit", task: AUDIT_TASK, role: "explore" }),
      call("spawn-hourly", "agent_spawn", { name: "hourly", task: HOURLY_TASK, role: "work" }),
      call("spawn-review", "agent_spawn", {
        name: "api-review",
        task: REVIEW_TASK,
        role: "advise",
        model: "openai-codex/gpt-6.1-sol",
      }),
    ],
  },
  { blocks: [think("三个都派出去了，等它们都有结果再一起看。"), call("wait-1", "agent_wait", { until: "all" })] },
  {
    waitFor: "answer",
    blocks: [
      call("reply-1", "agent_reply", {
        to: "cache-audit",
        questionId: "{{questionId}}",
        answer: "30 分钟，和接口的更新频率对齐。",
      }),
    ],
  },
  { blocks: [call("wait-2", "agent_wait", { until: "all" })] },
  {
    blocks: [call("edit-cache", "edit", { path: "src/cache.ts", edits: [{ oldText: CACHE_OLD, newText: CACHE_NEW }] })],
  },
  {
    blocks: [
      say(
        "三件事都做完了：缓存加了 30 分钟的有效期；逐小时预报在 `agent/hourly` 分支上，看过就可以合进 `main`。GPT-6.1 Sol 指出 `fetch` 没有超时、503 不重试，要不要我接着补上？",
      ),
    ],
  },
];

/** Each child's replies, picked by a phrase of its task; gated replies let the story time each one. */
export const CHILDREN: ReadmeFauxScript["children"] = [
  {
    match: "src/cache.ts 的缓存",
    replies: [
      {
        blocks: [
          think("先看缓存存了什么、什么时候删。"),
          call("a-read-1", "read", { path: "src/cache.ts" }),
          call("a-read-2", "read", { path: "src/api.ts" }),
        ],
      },
      {
        blocks: [
          call("a-progress", "report_progress", {
            message: "cache.ts 只有 get / set，没有过期时间；在看 api.ts 怎么用它",
          }),
        ],
      },
      {
        waitFor: "audit-ask",
        blocks: [
          call("a-ask", "ask_parent", {
            question: "缓存的有效期按多久算？预报接口每 30 分钟更新一次，要不要和它对齐？",
            options: ["30 分钟，和接口对齐", "1 小时"],
          }),
        ],
      },
      {
        waitFor: "audit-done",
        blocks: [
          say(`**结论**：会。\`src/cache.ts\` 的 \`entries\` 只存预报、不存时间，\`get\` 永远返回第一次的结果，应用不重启，首页就一直是旧数据。

- 第 4 行：\`Map<string, Forecast>\` 没有记存入的时间
- 第 7–9 行：\`get\` 不判断过期
- \`api.ts\` 第 20–21 行：命中缓存后直接返回，不会再请求

建议按主 agent 定的 30 分钟：存入时记下 \`savedAt\`，\`get\` 时超过 30 分钟就删掉并返回 \`undefined\`。`),
        ],
      },
    ],
  },
  {
    match: "fetchHourly（接口",
    replies: [
      {
        blocks: [
          think("先看现有的接口和首页的结构。"),
          call("h-read-1", "read", { path: "src/api.ts" }),
          call("h-read-2", "read", { path: "src/pages/home.tsx" }),
        ],
      },
      {
        blocks: [
          call("h-progress-1", "report_progress", {
            message: "接口对上了：/forecast/hourly 返回整点预报，开始写 fetchHourly 和 HourlyStrip",
          }),
        ],
      },
      {
        waitFor: "hourly-go",
        blocks: [
          call("h-edit-api", "edit", { path: "src/api.ts", edits: [{ oldText: API_OLD_TAIL, newText: API_NEW_TAIL }] }),
          call("h-write-strip", "write", { path: "src/components/hourly-strip.tsx", content: STRIP }),
        ],
      },
      {
        blocks: [
          call("h-edit-home", "edit", {
            path: "src/pages/home.tsx",
            edits: [
              {
                oldText:
                  'import { type Forecast, fetchForecast } from "../api";\nimport { DailyList } from "../components/daily-list";',
                newText:
                  'import { type Forecast, type HourlyForecast, fetchForecast, fetchHourly } from "../api";\nimport { DailyList } from "../components/daily-list";\nimport { HourlyStrip } from "../components/hourly-strip";',
              },
              {
                oldText:
                  "  const [forecast, setForecast] = useState<Forecast | null>(null);\n\n  useEffect(() => {\n    void fetchForecast(city).then(setForecast);\n  }, [city]);",
                newText:
                  "  const [forecast, setForecast] = useState<Forecast | null>(null);\n  const [hours, setHours] = useState<HourlyForecast[]>([]);\n\n  useEffect(() => {\n    void fetchForecast(city).then(setForecast);\n    void fetchHourly(city).then(setHours);\n  }, [city]);",
              },
              {
                oldText: "      <DailyList days={forecast.days} />",
                newText: "      <HourlyStrip hours={hours} />\n      <DailyList days={forecast.days} />",
              },
            ],
          }),
        ],
      },
      {
        blocks: [call("h-progress-2", "report_progress", { message: "首页接上了逐小时列表，在补测试" })],
      },
      { blocks: [call("h-write-test", "write", { path: "tests/hourly.test.ts", content: HOURLY_TEST })] },
      { blocks: [call("h-stat", "bash", { command: "git status --short" })] },
      {
        waitFor: "hourly-done",
        blocks: [
          say(`做完了，改动在 \`agent/hourly\` 分支上：

- \`src/api.ts\`：新增 \`HourlyForecast\` 和 \`fetchHourly\`
- \`src/components/hourly-strip.tsx\`：横向显示 24 个整点，降水概率到 30% 才标出来
- \`src/pages/home.tsx\`：当前温度下面接上逐小时列表
- \`tests/hourly.test.ts\`：两条测试

没有动缓存，\`fetchHourly\` 暂时不走 \`cache\`。`),
        ],
      },
    ],
  },
  {
    match: "的错误处理：网络失败",
    replies: [
      { blocks: [call("r-read", "read", { path: "src/api.ts" })] },
      {
        blocks: [call("r-progress", "report_progress", { message: "看完 fetchForecast，在对照首页怎么处理它抛的错" })],
      },
      { blocks: [call("r-read-home", "read", { path: "src/pages/home.tsx" })] },
      {
        waitFor: "review-done",
        blocks: [
          say(`按严重程度：

1. **没有超时**：\`fetch\` 没带 \`signal\`，接口挂住时首页一直是“加载中…”。建议 \`AbortSignal.timeout(5000)\`。
2. **失败不重试**：偶发的 503 直接抛错，\`home.tsx\` 的 \`useEffect\` 没有 \`catch\`，首页停在“加载中…”。
3. **返回格式没校验**：\`as Forecast\` 只是断言，字段缺了要到渲染时才出错。

缓存的问题不在这次范围里。`),
        ],
      },
    ],
  },
];
