import atriumAgent, { type AgentApi } from "../agent/extension";
import atriumFast, { type FastApi } from "../fast/extension";
import atriumEdit, { type EditApi } from "../edit/extension";
import atriumPlan, { type PlanApi } from "../plan/extension";
import atriumSearch, { type SearchApi } from "../search/extension";

/**
 * Atrium's own pi extension: Fast, plans, child conversations, web tools and stopped-message editing.
 *
 * @remarks
 * One file for pi to load in the pi processes Atrium starts (overview.md, "Atrium 自带的 pi 扩展";
 * ADR-0008, ADR-0010, ADR-0013, ADR-0014); each part registers what it needs.
 *
 * @sideEffects Registers commands and request hooks with pi.
 * @param pi - pi's extension API.
 */
export default function atrium(pi: FastApi & PlanApi & AgentApi & SearchApi & EditApi): void {
  atriumFast(pi);
  atriumPlan(pi);
  atriumAgent(pi);
  atriumSearch(pi);
  atriumEdit(pi);
}
