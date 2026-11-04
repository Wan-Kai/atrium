import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";

// Inspect the exact transitive ESM modules used by @streamdown/mermaid, not a second Mermaid copy.
const pluginRequire = createRequire(
  realpathSync(new URL("../../node_modules/@streamdown/mermaid/package.json", import.meta.url)),
);
const layout = (await import(pluginRequire.resolve("mermaid/dist/chunks/mermaid.core/chunk-2E4U76K2.mjs"))) as {
  createCommonLayoutRenderer: (
    phases: Record<Phase, () => unknown>,
  ) => (data: object, svg: { select: () => object }, helpers: { insertMarkers: () => void }) => Promise<void>;
  clearLayoutRenderState: () => void;
};
const edges = (await import(pluginRequire.resolve("mermaid/dist/chunks/mermaid.core/chunk-OSK3NFVY.mjs"))) as {
  edgeLabels: Map<string, object>;
  terminalLabels: Map<string, object>;
};

type Phase = "prepareLayout" | "measureLayout" | "runLayoutCore" | "paintLayout" | "afterPaint";
const phases: Phase[] = ["prepareLayout", "measureLayout", "runLayoutCore", "paintLayout", "afterPaint"];

afterEach(() => layout.clearLayoutRenderState());

describe("Mermaid layout cache lifetime", () => {
  it("retains drawing references through painting, then releases them on success", async () => {
    const selection = {};
    const render = layout.createCommonLayoutRenderer({
      prepareLayout: () => {
        edges.edgeLabels.set("edge", selection);
        edges.terminalLabels.set("edge", selection);
      },
      measureLayout: () => undefined,
      runLayoutCore: () => undefined,
      paintLayout: () => {
        expect(edges.edgeLabels.get("edge")).toBe(selection);
        expect(edges.terminalLabels.get("edge")).toBe(selection);
      },
      afterPaint: () => {
        expect(edges.edgeLabels.get("edge")).toBe(selection);
        expect(edges.terminalLabels.get("edge")).toBe(selection);
      },
    });
    await render({}, { select: () => ({}) }, { insertMarkers: () => {} });
    expect([...edges.edgeLabels, ...edges.terminalLabels]).toStrictEqual([]);
  });

  it.each(phases)("releases drawing references when %s rejects, preserving the error", async (failure) => {
    const error = new Error("layout failure");
    const steps = Object.fromEntries(phases.map((phase) => [phase, () => undefined])) as Record<Phase, () => unknown>;
    /**
     * Fails a layout phase after it has retained a drawing selection.
     * @remarks Exercises the real factory's cleanup rather than mocking its modules.
     * @sideEffects Adds references to Mermaid's shared label maps.
     */
    steps[failure] = () => {
      edges.edgeLabels.set("edge", {});
      edges.terminalLabels.set("edge", {});
      return Promise.reject(error);
    };
    const render = layout.createCommonLayoutRenderer(steps);
    await expect(render({}, { select: () => ({}) }, { insertMarkers: () => {} })).rejects.toBe(error);
    expect([...edges.edgeLabels, ...edges.terminalLabels]).toStrictEqual([]);
  });
});
