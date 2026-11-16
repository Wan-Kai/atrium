import { Cadence, SchedulePlace } from "@atrium/protocol";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { writeAtomically } from "../store/index-file";
import { GraphEdge, GraphNode, Task } from "./types";

/*
 * The schedule rules and the file they live in (`<home>/schedules.json`; SPEC-0006, "定时规则").
 */

/** A rule: when a task is made, from what, and what became of the last one (SPEC-0006, "定时规则"). */
export const ScheduleRule = z.strictObject({
  id: z.string().regex(/^rul_[0-9A-Za-z_-]{1,64}$/u),
  name: z.string(),
  projectId: z.string().min(1),
  /** The container the template's conversation lives in, which the conversations of triggered tasks are put in. */
  containerId: z.string().min(1),
  /** The directory the template was made in: the `sourceDir` of every task it makes. */
  sourceDir: z.string().min(1),
  when: Cadence,
  place: SchedulePlace,
  summary: Task.shape.summary,
  graph: z.strictObject({ nodes: z.array(GraphNode), edges: z.array(GraphEdge) }),
  model: Task.shape.model,
  /** The template: a designing task that holds the rule's conversation. */
  templateTaskId: z.string().min(1),
  /** The template's conversation, which "修改" opens. */
  taskSessionId: z.string().min(1),
  paused: z.boolean(),
  createdAt: z.number(),
  /** The latest time the rule should have fired, whether or not it made a task (a skipped trigger counts). */
  lastFiredAt: z.number().nullable(),
  lastTaskId: z.string().nullable(),
  /** The triggers skipped since a task was last made. */
  skipped: z.number().int().min(0),
});
export type ScheduleRule = z.infer<typeof ScheduleRule>;

/** The file: a version and the rules in the order they were made. */
const ScheduleFile = z.strictObject({ v: z.literal(1), rules: z.array(z.unknown()) });

/**
 * Reads the rules.
 *
 * @remarks
 * A missing file is no rules. A rule that does not fit its schema is not used but handed back in `rest`, as it was
 * written, for `writeRules` to put back: one broken by hand (or written by a newer Atrium) is not lost when another
 * rule changes. A file that is not JSON of the right shape is an error: the caller must not write over it.
 *
 * @sideEffects Reads the file.
 * @param path - `schedules.json`.
 * @returns The rules, and the entries that could not be read.
 * @throws {Error} When the file exists but is not a rules file.
 */
export async function readRules(path: string): Promise<{ rules: ScheduleRule[]; rest: unknown[] }> {
  const text = await readFile(path, "utf8").catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  });
  if (text === null) return { rules: [], rest: [] };
  const parsed = ScheduleFile.parse(JSON.parse(text));
  const rules: ScheduleRule[] = [];
  const rest: unknown[] = [];
  for (const raw of parsed.rules) {
    const rule = ScheduleRule.safeParse(raw);
    if (rule.success) rules.push(rule.data);
    else rest.push(raw);
  }
  return { rules, rest };
}

/**
 * Writes the rules.
 *
 * @remarks
 * Atomically: a crash leaves the old file or the new one, never half of either.
 *
 * @sideEffects Replaces the file.
 * @param path - `schedules.json`.
 * @param rules - The rules.
 * @param rest - The entries `readRules` could not read, kept after the rules.
 */
export async function writeRules(
  path: string,
  rules: readonly ScheduleRule[],
  rest: readonly unknown[],
): Promise<void> {
  await writeAtomically(path, `${JSON.stringify({ v: 1, rules: [...rules, ...rest] }, null, 1)}\n`);
}
