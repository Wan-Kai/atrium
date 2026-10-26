import { describe, expect, it } from "vitest";
import { ResourceTracker } from "./resources";

describe("ResourceTracker", () => {
  it("counts open resources per kind, keeps released kinds at zero and lists kinds alphabetically", () => {
    const resources = new ResourceTracker();
    const releaseTimer = resources.acquire("timer");
    resources.acquire("ws.phone");
    resources.acquire("stream");

    releaseTimer();
    releaseTimer();

    expect(Object.entries(resources.snapshot())).toStrictEqual([
      ["stream", 1],
      ["timer", 0],
      ["ws.phone", 1],
    ]);
  });
});
