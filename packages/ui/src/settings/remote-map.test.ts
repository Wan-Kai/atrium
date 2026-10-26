import { describe, expect, it } from "vitest";
import { deviceColor, packetFrame, lanePoint } from "./remote-map";

describe("remote link map", () => {
  it("converges upstream, holds inside relay, reaches Mac, then fans downstream in 3900ms", () => {
    expect([0, 320, 700, 1040, 1400, 1860, 2180, 2580, 3200, 3900].map(packetFrame)).toStrictEqual([
      { direction: "up", lane: 1, trunk: null, lock: false },
      { direction: "up", lane: 0.5, trunk: null, lock: false },
      { direction: "up", lane: null, trunk: null, lock: true },
      { direction: "up", lane: null, trunk: 0.5, lock: false },
      { direction: null, lane: null, trunk: null, lock: false },
      { direction: "down", lane: null, trunk: 0.5, lock: false },
      { direction: "down", lane: null, trunk: null, lock: true },
      { direction: "down", lane: 0.5, trunk: null, lock: false },
      { direction: null, lane: null, trunk: null, lock: false },
      { direction: "up", lane: 1, trunk: null, lock: false },
    ]);
  });
  it("keeps every segment boundary and the brief lock flashes exact", () => {
    expect([640, 780, 1300, 1600, 2120, 2260, 2900].map(packetFrame)).toStrictEqual([
      { direction: "up", lane: null, trunk: null, lock: true },
      { direction: "up", lane: null, trunk: 1, lock: true },
      { direction: null, lane: null, trunk: null, lock: false },
      { direction: "down", lane: null, trunk: 0, lock: false },
      { direction: "down", lane: null, trunk: null, lock: true },
      { direction: "down", lane: 0, trunk: null, lock: true },
      { direction: null, lane: null, trunk: null, lock: false },
    ]);
    expect([590, 591, 819, 820, 2080, 2081, 2309, 2310].map((time) => packetFrame(time).lock)).toStrictEqual([
      false,
      true,
      true,
      false,
      false,
      true,
      true,
      false,
    ]);
    expect([160, 480].map((time) => packetFrame(time).lane)).toStrictEqual([0.9375, 0.0625]);
    expect([910, 1170].map((time) => packetFrame(time).trunk)).toStrictEqual([0.9375, 0.0625]);
    expect(lanePoint(60, 0.25)).toStrictEqual({ x: 318.171875, y: 103.875 });
  });

  it("uses symmetric S lanes and stable five-colour hashes independent of names", () => {
    expect(lanePoint(60, 0)).toStrictEqual({ x: 268, y: 112 });
    expect(lanePoint(60, 1)).toStrictEqual({ x: 437, y: 60 });
    expect(lanePoint(164, 0.5)).toStrictEqual({ x: 352.5, y: 138 });
    expect(Array.from({ length: 10 }, (_, index) => deviceColor(`dev_${index}`))).toStrictEqual([
      2, 3, 4, 0, 1, 2, 3, 4, 0, 1,
    ]);
  });
});
