import { describe, expect, it } from "vitest";
import { renderPlantuml } from "./plantuml";
import type { UiClock } from "../state/clock";

/** A real deadline source for the real worker integration tests.
 * @remarks Tests must exercise the actual engine without substituting its drawing.
 * @sideEffects Schedules deadlines until cancelled.
 */
const clock: UiClock = {
  now: () => performance.timeOrigin + performance.now(),
  every: () => {
    throw new Error("no repeating work");
  },
  after(ms, run) {
    const timer = window.setTimeout(run, ms);
    return () => window.clearTimeout(timer);
  },
};

describe("local PlantUML engine", () => {
  it.each([
    ["sequence", "participant 界面\nparticipant 宿主\n界面 -> 宿主: 消息"],
    ["class", "class User\nclass Team\nUser --> Team"],
    ["activity", "start\n:Read;\n:Reply;\nstop"],
    ["component", "[Client] --> [Host]"],
  ])("draws a %s diagram with the real worker", async (_kind, body) => {
    const svg = await renderPlantuml(`@startuml\n${body}\n@enduml`, false, new AbortController().signal, clock);
    const root = new DOMParser().parseFromString(svg, "image/svg+xml").documentElement;
    expect(root.localName).toBe("svg");
    expect(root.querySelectorAll("path,rect,line").length).toBeGreaterThan(0);
    expect(root.querySelector("parsererror")).toBeNull();
  });

  it.each([
    { dark: false, fill: "#FFFFFF", border: "#C9CED7", ink: "#303641" },
    { dark: true, fill: "#24262C", border: "#555B65", ink: "#E3E5E9" },
  ])(
    "uses the approved neutral B skin without duplicate foot participants (dark=$dark)",
    async ({ dark, fill, border, ink }) => {
      const svg = await renderPlantuml(
        "@startuml\nAlice -> Bob: hello\n@enduml",
        dark,
        new AbortController().signal,
        clock,
      );
      const root = new DOMParser().parseFromString(svg, "image/svg+xml");
      const head = root.querySelector(".participant-head rect");
      expect(head?.getAttribute("fill")).toBe(fill);
      expect(head?.getAttribute("stroke")).toBe(border);
      const text = [...root.querySelectorAll("text")];
      expect(text.map((node) => node.textContent).filter((value) => value === "Alice")).toStrictEqual(["Alice"]);
      expect(text.find((node) => node.textContent === "hello")?.getAttribute("fill")).toBe(ink);
      expect([...new Set(text.map((node) => node.getAttribute("font-family")))]).toStrictEqual(["'PingFang SC'"]);
      expect([...new Set(text.map((node) => node.getAttribute("font-size")))]).toStrictEqual(["13"]);
      expect(root.querySelector("filter")).toBeNull();
    },
  );

  it.each([false, true])("lets explicit source skin parameters override the default B skin (dark=%s)", async (dark) => {
    const source = "@startuml\nskinparam sequenceParticipantBackgroundColor #FF0000\nAlice -> Bob: hello\n@enduml";
    const svg = await renderPlantuml(source, dark, new AbortController().signal, clock);
    const root = new DOMParser().parseFromString(svg, "image/svg+xml");
    expect(root.querySelector(".participant-head rect")?.getAttribute("fill")).toBe("#FF0000");
  });

  it("checks the final scaled SVG dimensions, not only the engine's pre-scale size", async () => {
    const source = `@startuml\nscale 4\nAlice -> Bob: ${"W".repeat(400)}\n@enduml`;
    await expect(renderPlantuml(source, false, new AbortController().signal, clock)).rejects.toThrow("too_large");
  });

  it("uses dark colours and keeps the diagram's words", async () => {
    const svg = await renderPlantuml(
      "@startuml\nAlice -> Bob: hello\n@enduml",
      true,
      new AbortController().signal,
      clock,
    );
    expect(svg).toContain("hello");
    const root = new DOMParser().parseFromString(svg, "image/svg+xml");
    expect(root.querySelector(".participant-head rect")?.getAttribute("fill")).toBe("#24262C");
  });

  it.each([
    "!include https://example.invalid/secret.puml",
    "!define ROOT https://example.invalid/\n!include ROOT/file.puml",
  ])("refuses external resources: %s", async (directive) => {
    await expect(
      renderPlantuml(`@startuml\n${directive}\nAlice -> Bob\n@enduml`, false, new AbortController().signal, clock),
    ).rejects.toThrow("failed");
  });

  it("refuses files and extra libraries rather than loading them", async () => {
    const source = "@startuml\n!include secret.puml\nAlice -> Bob\n@enduml";
    await expect(renderPlantuml(source, false, new AbortController().signal, clock)).rejects.toThrow("failed");
    await expect(
      renderPlantuml("@startuml\n!include <C4/C4_Context>\n@enduml", false, new AbortController().signal, clock),
    ).rejects.toThrow("failed");
  });
});
