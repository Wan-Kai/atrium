import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The gate the probe's `agent_end` waits on, in the faux model's gates directory. */
export const AGENT_END_GATE = "agent-end";
/** The file the probe writes in that directory once a run's `agent_end` reached it. */
export const AGENT_END_REACHED = "agent-end-reached";

/**
 * Holds pi at a run's `agent_end` until the test releases it.
 *
 * @remarks
 * Loaded before Atrium's extension, its handler runs first, so what the host delivers meanwhile
 * comes after the run's last turn end and before Atrium's own `agent_end` handler (SPEC-0002,
 * "送达"). Only the first run is held. The gates directory is the faux model's (`FAUX_PI_GATES`).
 *
 * @sideEffects Registers an `agent_end` handler that writes a file and waits for another.
 * @param pi - pi's extension API.
 */
export default function agentEndProbe(pi: ExtensionAPI): void {
  const gates = process.env["FAUX_PI_GATES"] ?? "";
  let held = false;
  pi.on("agent_end", async () => {
    if (held || gates === "") return;
    held = true;
    writeFileSync(join(gates, AGENT_END_REACHED), "");
    const gate = join(gates, AGENT_END_GATE);
    // Bounded by the test's own timeout, as the faux model's gates are.
    while (!existsSync(gate)) await new Promise((resolve) => setTimeout(resolve, 20));
  });
}
