import { describe, expect, it } from "vitest";
import { SNAPSHOTS_KEPT, SNAPSHOT_BYTES, VisualSnapshots } from "./visual-snapshots";

describe("VisualSnapshots", () => {
  it("keeps the latest image of each visual, shown only in the appearance it was taken in", () => {
    const snapshots = new VisualSnapshots();
    snapshots.set("a", "data:1", false);
    snapshots.set("a", "data:2", false);
    snapshots.set("d", "data:3", true);

    expect([
      snapshots.get("a", false),
      snapshots.get("a", true),
      snapshots.get("d", true),
      snapshots.get("d", false),
      snapshots.get("b", false),
    ]).toStrictEqual(["data:2", null, "data:3", null, null]);
  });

  it("forgets the visual taken least recently once it keeps more than its limit", () => {
    const snapshots = new VisualSnapshots();
    for (let index = 0; index < SNAPSHOTS_KEPT; index += 1) snapshots.set(`v${index}`, `data:${index}`, false);
    snapshots.set("v0", "data:again", false);
    snapshots.set("new", "data:new", false);

    expect(SNAPSHOTS_KEPT).toBe(64);
    expect(["v0", "v1", "v2", "new"].map((key) => snapshots.get(key, false))).toStrictEqual([
      "data:again",
      null,
      "data:2",
      "data:new",
    ]);
  });

  it("keeps no more than its bytes, forgetting the least recent first, and none that alone is too large", () => {
    const snapshots = new VisualSnapshots();
    const third = "x".repeat(Math.floor(SNAPSHOT_BYTES / 3));
    snapshots.set("a", third, false);
    snapshots.set("b", third, false);
    snapshots.set("c", third, false);
    snapshots.set("d", third, false);
    snapshots.set("huge", "y".repeat(SNAPSHOT_BYTES + 1), false);

    expect(SNAPSHOT_BYTES).toBe(32 * 1024 * 1024);
    expect(["a", "b", "c", "d", "huge"].map((key) => snapshots.get(key, false) !== null)).toStrictEqual([
      false,
      true,
      true,
      true,
      false,
    ]);
  });

  it("tells its listeners of every change, a forgotten image included, until they stop", () => {
    const snapshots = new VisualSnapshots();
    let told = 0;
    const stop = snapshots.subscribe(() => {
      told += 1;
    });
    for (let index = 0; index <= SNAPSHOTS_KEPT; index += 1) snapshots.set(`v${index}`, "data:x", false);
    stop();
    snapshots.set("after", "data:x", false);

    expect(told).toBe(SNAPSHOTS_KEPT + 1);
    expect(snapshots.get("v0", false)).toBeNull();
  });
});
