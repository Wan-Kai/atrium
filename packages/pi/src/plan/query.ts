import type { PlanProvider } from "@atrium/protocol";
import type { PiProcess } from "../process/pi-process";
import { PLAN_COMMAND, PLAN_STATUS, type PlanReport, isPlanQuery, readPlanReport } from "./plan";

/** How long a session's pi gets to answer the plan query (ADR-0010). */
const PLAN_WAIT_MS = 20_000;

/**
 * Asks a session's pi for a subscription's usage, through Atrium's extension.
 *
 * @remarks
 * ADR-0010, SPEC-0001 ("M1.13 的上下文细分与套餐用量"): only when pi lists the extension's
 * `atrium-plan`, or pi would pass the words to the model. pi runs the command at once, even during
 * a run, and the extension reports as the status `atrium-plan` before pi answers the prompt
 * (pi-internals.md §5); a report for another provider, or one that does not fit, counts as none.
 *
 * @sideEffects Sends pi two commands, the second making the extension ask the provider.
 * @param pi - The session's pi.
 * @param provider - The subscription.
 * @param waitMs - How long the extension gets, {@link PLAN_WAIT_MS} by default; tests shorten it.
 * @returns The report, or `null` when pi has no plan query or reported nothing that fits.
 * @throws {PiRequestError} When pi refuses or does not answer, or exits.
 */
export async function queryPlanUsage(
  pi: Pick<PiProcess, "request" | "onEvent">,
  provider: PlanProvider,
  waitMs = PLAN_WAIT_MS,
): Promise<PlanReport | null> {
  const { commands } = await pi.request({ type: "get_commands" });
  if (!commands.some(isPlanQuery)) return null;
  const seen: { report: PlanReport | null } = { report: null };
  const unsubscribe = pi.onEvent((event) => {
    // Stryker disable next-line ConditionalExpression,LogicalOperator: pi gives a status key to setStatus alone; the first two checks narrow the type.
    if (event.type !== "extension_ui_request" || event.method !== "setStatus" || event.statusKey !== PLAN_STATUS)
      return;
    const report = readPlanReport(event.statusText);
    if (report?.provider === provider) seen.report = report;
  });
  // The promise's `finally` rather than a `finally` block, whose mutant no comment reaches (testing.md).
  await pi
    .request({ type: "prompt", message: `/${PLAN_COMMAND} ${provider}` }, { timeoutMs: waitMs })
    .finally(unsubscribe);
  return seen.report;
}
