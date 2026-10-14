import { describe, expect, it } from "vitest";
import { createPanes, fitPanelWidth, memoryStorage, panelWidthCss } from "./panes";

describe("fitPanelWidth", () => {
  it("keeps the width wanted, whole, while the conversation keeps 440px and the panel 240px", () => {
    expect([
      fitPanelWidth(320.4, 1400),
      fitPanelWidth(960, 1400),
      fitPanelWidth(961, 1400),
      fitPanelWidth(239, 1400),
      fitPanelWidth(320, 600),
    ]).toStrictEqual([320, 960, 960, 240, 240]);
  });
});

describe("panelWidthCss", () => {
  it("fits the width, whole, as fitPanelWidth does, against the room CSS knows", () => {
    expect(panelWidthCss(320.4)).toBe("max(240px, min(320px, 100% - 440px))");
  });
});

describe("createPanes", () => {
  it("starts unfolded, closed and 320px wide with nothing stored", () => {
    const { sidebarCollapsed, panelOpen, panelWidth } = createPanes(memoryStorage()).getState();

    expect({ sidebarCollapsed, panelOpen, panelWidth }).toStrictEqual({
      sidebarCollapsed: false,
      panelOpen: false,
      panelWidth: 320,
    });
  });

  it("writes each choice down, and starts from what was written", () => {
    const storage = memoryStorage();
    const panes = createPanes(storage);

    panes.getState().toggleSidebar();
    panes.getState().setPanelOpen(true);
    panes.getState().setPanelWidth(480);
    const live = panes.getState();
    const { sidebarCollapsed, panelOpen, panelWidth } = createPanes(storage).getState();

    expect([live.sidebarCollapsed, live.panelOpen, live.panelWidth]).toStrictEqual([true, true, 480]);

    expect([
      storage.getItem("atrium.sidebarCollapsed"),
      storage.getItem("atrium.changesOpen"),
      storage.getItem("atrium.rightPanelWidth"),
    ]).toStrictEqual(["true", "true", "480"]);
    expect({ sidebarCollapsed, panelOpen, panelWidth }).toStrictEqual({
      sidebarCollapsed: true,
      panelOpen: true,
      panelWidth: 480,
    });
    panes.getState().toggleSidebar();
    expect([panes.getState().sidebarCollapsed, storage.getItem("atrium.sidebarCollapsed")]).toStrictEqual([
      false,
      "false",
    ]);
  });

  it("reads a stored width that is no number, or under 240px, as 320px, and a fraction as whole", () => {
    const widths = ["wide", "", "239", "Infinity", "240", "400.6"].map((stored) => {
      const storage = memoryStorage();
      storage.setItem("atrium.rightPanelWidth", stored);
      return createPanes(storage).getState().panelWidth;
    });

    expect(widths).toStrictEqual([320, 320, 320, 320, 240, 401]);
  });

  it("does not carry over the width kept before M1.12", () => {
    const storage = memoryStorage();
    storage.setItem("atrium.changesWidth", "560");

    expect(createPanes(storage).getState().panelWidth).toBe(320);
  });
});
