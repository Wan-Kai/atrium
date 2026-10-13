import { describe, expect, it } from "vitest";
import { createPanes, fitPanelWidth, memoryStorage, panelWidthCss } from "./panes";

describe("fitPanelWidth", () => {
  it("keeps the width wanted, whole, while the conversation keeps 440px and the panel 360px", () => {
    expect([
      fitPanelWidth(560.4, 1400),
      fitPanelWidth(960, 1400),
      fitPanelWidth(961, 1400),
      fitPanelWidth(359, 1400),
      fitPanelWidth(560, 700),
    ]).toStrictEqual([560, 960, 960, 360, 360]);
  });
});

describe("panelWidthCss", () => {
  it("fits the width, whole, as fitPanelWidth does, against the room CSS knows", () => {
    expect(panelWidthCss(560.4)).toBe("max(360px, min(560px, 100% - 440px))");
  });
});

describe("createPanes", () => {
  it("starts unfolded, closed and 560px wide with nothing stored", () => {
    const { sidebarCollapsed, panelOpen, panelWidth } = createPanes(memoryStorage()).getState();

    expect({ sidebarCollapsed, panelOpen, panelWidth }).toStrictEqual({
      sidebarCollapsed: false,
      panelOpen: false,
      panelWidth: 560,
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
      storage.getItem("atrium.changesWidth"),
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

  it("reads a stored width that is no number, or under 360px, as 560px, and a fraction as whole", () => {
    const widths = ["wide", "", "359", "Infinity", "360", "400.6"].map((stored) => {
      const storage = memoryStorage();
      storage.setItem("atrium.changesWidth", stored);
      return createPanes(storage).getState().panelWidth;
    });

    expect(widths).toStrictEqual([560, 560, 560, 560, 360, 401]);
  });
});
