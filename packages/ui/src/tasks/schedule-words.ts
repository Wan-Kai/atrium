import { CommandError } from "@atrium/client";
import type { Cadence, ScheduleSummary, SchedulePlace } from "@atrium/protocol";
import { describeTaskCommandError } from "./review-words";

/*
 * The words of the 定时 tab (设计稿第 3 屏; SPEC-0006, "T10 定下的细节"). The host sends cadences, instants and states; the
 * words are made here, in one place, so that they can be changed together.
 */

/** The weekdays, 0 for Sunday. */
const WEEKDAY = ["日", "一", "二", "三", "四", "五", "六"];

/**
 * A time of day as people say it: "凌晨 2:00", "早上 9:00", "下午 2:30".
 *
 * @remarks
 * 设计稿 writes "每天凌晨 2:00" and "每天早上 9:00": the part of the day, then the hour in the 12-hour style, with
 * the minutes. The parts are 凌晨 (0 to 5), 早上 (6 to 11), 中午 (12), 下午 (13 to 17) and 晚上 (18 to 23). Midnight is
 * "凌晨 12:00" and noon "中午 12:00": the 12-hour clock has no 0.
 *
 * @sideEffects none
 * @param at - `H:MM` or `HH:MM`, 24-hour.
 * @returns The words.
 */
function timeWords(at: string): string {
  const [hourText = "0", minute = "00"] = at.split(":");
  const hour = Number(hourText);
  const part = hour < 6 ? "凌晨" : hour < 12 ? "早上" : hour === 12 ? "中午" : hour < 18 ? "下午" : "晚上";
  // The 12-hour clock has no 0: midnight is 12, as noon is.
  const shown = hour % 12 === 0 ? 12 : hour % 12;
  return `${part} ${String(shown)}:${minute}`;
}

/**
 * When a rule fires, in plain words, never as cron.
 *
 * @remarks
 * 每天凌晨 2:00; 每周一 10:00 (the draft writes the week's hour in 24-hour style, without the part of the day);
 * 每 5 分钟, 每小时, 每 2 小时 for an interval.
 *
 * @sideEffects none
 * @param when - The cadence.
 * @returns The words.
 */
export function whenWords(when: Cadence): string {
  if (when.every === "day") return `每天${timeWords(when.at)}`;
  if (when.every === "week") {
    const [hour = "0", minute = "00"] = when.at.split(":");
    return `每周${WEEKDAY[when.day] ?? "?"} ${String(Number(hour))}:${minute}`;
  }
  if (when.minutes === 60) return "每小时";
  if (when.minutes % 60 === 0) return `每 ${String(when.minutes / 60)} 小时`;
  return `每 ${String(when.minutes)} 分钟`;
}

/**
 * A calendar day as a number, counted on the local calendar.
 *
 * @remarks
 * Counted from year, month and date, so a day with 23 or 25 hours still counts as one.
 *
 * @sideEffects none
 * @param date - The instant.
 * @returns Days since 1970-01-01 of the date on the local calendar.
 */
function dayNumber(date: Date): number {
  return Math.round(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000);
}

/**
 * When it fires next: "下次 今天 14:05", "下次 明天 2:00", "下次 11 月 12 日 2:00".
 *
 * @remarks
 * Relative to the clock the page was given; a paused rule has none, shown as a dash.
 *
 * @sideEffects none
 * @param nextAt - The instant, or `null`.
 * @param now - The time now.
 * @returns The words.
 */
export function nextWords(nextAt: number | null, now: number): string {
  if (nextAt === null) return "—";
  const at = new Date(nextAt);
  const today = new Date(now);
  const apart = dayNumber(at) - dayNumber(today);
  const clock = `${String(at.getHours())}:${String(at.getMinutes()).padStart(2, "0")}`;
  const date =
    apart === 0 ? "今天" : apart === 1 ? "明天" : `${String(at.getMonth() + 1)} 月 ${String(at.getDate())} 日`;
  return `下次 ${date} ${clock}`;
}

/**
 * Where each run works, in the draft's words.
 *
 * @remarks
 * Two places, as the draft words them.
 *
 * @sideEffects none
 * @param place - The rule's place.
 * @returns The words.
 */
export function placeWords(place: SchedulePlace): string {
  return place === "new_worktree" ? "每次新建 worktree" : "只读，在本地目录跑";
}

/** How the result column shows a rule. */
export interface ResultWords {
  readonly text: string;
  readonly tone: "danger" | "run" | "dim" | "plain";
  /** Which small picture goes with it. */
  readonly icon: "alert" | "run" | "pause" | "none";
}

/** What the result column says of the last task, by its status. */
const LAST_WORDS: Readonly<Record<NonNullable<ScheduleSummary["last"]>["status"], ResultWords>> = {
  running: { text: "这次在跑", tone: "run", icon: "run" },
  waiting: { text: "这次在等你", tone: "plain", icon: "none" },
  stopped: { text: "这次停下了", tone: "plain", icon: "none" },
  designing: { text: "这次停下了", tone: "plain", icon: "none" },
  cancelled: { text: "上次取消了", tone: "dim", icon: "none" },
  done: { text: "上次完成", tone: "plain", icon: "none" },
};

/**
 * The "上次结果" column: paused, the run that is going, what became of the last one, or a dash.
 *
 * @remarks
 * 设计稿: 上次失败 (red), 这次在跑 (running), 已暂停 (dim), "—" when it never ran. The other states a finished or
 * stopped task can be in are worded the same way and are for the user to confirm (T10 open questions).
 *
 * @sideEffects none
 * @param rule - The row.
 * @returns The words.
 */
export function resultWords(rule: ScheduleSummary): ResultWords {
  if (rule.paused) return { text: "已暂停", tone: "dim", icon: "pause" };
  const { last } = rule;
  if (last === null) return { text: "—", tone: "dim", icon: "none" };
  if (last.failed) return { text: "上次失败", tone: "danger", icon: "alert" };
  return LAST_WORDS[last.status];
}

/**
 * What the tab says when it could not ask for the rules.
 *
 * @remarks
 * A rules file the host cannot read has its own sentence (SPEC-0006, "T9 / T10 审查后用户定"); any other failure, such as a
 * connection that is not open, is "定时规则读取失败，稍后再试" and not "发送失败".
 *
 * @sideEffects none
 * @param error - What `watchSchedules` rejected with.
 * @returns The sentence.
 */
export function readFailureWords(error: unknown): string {
  return error instanceof CommandError && error.code === "schedule_file_unreadable"
    ? describeTaskCommandError(error)
    : "定时规则读取失败，稍后再试";
}

/**
 * The second line under a rule's name: the project, where it runs, and how many triggers were skipped.
 *
 * @remarks
 * 设计稿 note 11: "跳过 1 次 · 上次还在跑". "上次还在跑" is said only while the last run really is on (running, or
 * waiting for the user); a last run that failed or was stopped is not "还在跑", and one that is gone has nothing to say.
 *
 * @sideEffects none
 * @param rule - The row.
 * @param project - The project's name.
 * @returns The words.
 */
export function ruleSubWords(rule: ScheduleSummary, project: string): string {
  const going = rule.last !== null && !rule.last.failed && ["running", "waiting"].includes(rule.last.status);
  const skipped = rule.skipped > 0 ? `跳过 ${String(rule.skipped)} 次${going ? " · 上次还在跑" : ""}` : null;
  return [project, placeWords(rule.place), skipped].filter((part): part is string => part !== null).join(" · ");
}
