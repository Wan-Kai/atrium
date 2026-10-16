import atriumFast, { type FastApi } from "../fast/extension";
import atriumPlan, { type PlanApi } from "../plan/extension";

/**
 * Atrium's own pi extension: Fast and the plan query.
 *
 * @remarks
 * One file for pi to load in the pi processes Atrium starts (overview.md, "Atrium 自带的 pi 扩展";
 * ADR-0008, ADR-0010); each part registers what it needs.
 *
 * @sideEffects Registers commands and a request hook with pi.
 * @param pi - pi's extension API.
 */
export default function atrium(pi: FastApi & PlanApi): void {
  atriumFast(pi);
  atriumPlan(pi);
}
