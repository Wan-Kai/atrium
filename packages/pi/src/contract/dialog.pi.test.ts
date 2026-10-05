import { describe, expect, it } from "vitest";
import { runScenario } from "../../test/contract";
import type { PiEvent } from "../process/pi-process";

/** Matches an extension dialog request of the given method. */
function dialogOf(method: string): (event: PiEvent) => boolean {
  return (event) => event.type === "extension_ui_request" && event.method === method;
}

describe("pi contract: extension dialogs", () => {
  it("dialog: an extension asks through extension_ui_request and continues with the answer", async () => {
    await runScenario({ scenario: "dialog", script: { replies: [] } }, async ({ pi, events, until }) => {
      const prompt = pi.request({ type: "prompt", message: "/faux-confirm" });
      const request = await until(dialogOf("confirm"));
      pi.respond({ type: "extension_ui_response", id: (request as { id: string }).id, confirmed: true });

      expect(await prompt).toStrictEqual({ disposition: "handled" });
      await until(dialogOf("notify"));
      expect(request).toMatchObject({ title: "Proceed?", message: "The faux extension asks." });
      expect(events.at(-1)).toMatchObject({ method: "notify", message: "confirmed", notifyType: "info" });
    });
  });
});
