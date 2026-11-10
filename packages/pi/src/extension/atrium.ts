import { AGENT_FLAG } from "../agent/channel";
import atriumAgent, { type AgentApi, selfOf } from "../agent/extension";
import atriumFast, { type FastApi } from "../fast/extension";
import atriumEdit, { type EditApi } from "../edit/extension";
import atriumPlan, { type PlanApi } from "../plan/extension";
import atriumTask, { type TaskApi } from "../task/extension";
import atriumSearch, { type SearchApi } from "../search/extension";
import atriumStudy, { type StudyApi } from "../study/extension";
import atriumVisuals, { type VisualsApi } from "../visuals/extension";

/**
 * Atrium's own pi extension: Fast, plans, child conversations, task nodes, the path and git guards, web tools,
 * stopped-message editing, the instructions on inline visuals and study mode's tools.
 *
 * @remarks
 * One file for pi to load in the pi processes Atrium starts (overview.md, "Atrium 自带的 pi 扩展";
 * ADR-0008, ADR-0010, ADR-0013, ADR-0014, SPEC-0006, SPEC-0007, SPEC-0008); each part registers what it needs.
 *
 * @sideEffects Registers commands, flags and request hooks with pi.
 * @param pi - pi's extension API.
 */
export default function atrium(
  pi: FastApi & PlanApi & AgentApi & TaskApi & SearchApi & EditApi & VisualsApi & StudyApi,
): void {
  atriumFast(pi);
  atriumPlan(pi);
  const channel = atriumAgent(pi);
  atriumTask(pi, () => selfOf(pi.getFlag(AGENT_FLAG)).isolated === true);
  atriumSearch(pi);
  atriumEdit(pi);
  atriumVisuals(pi);
  atriumStudy(pi, channel);
}
