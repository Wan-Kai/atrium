import { describe, expect, it } from "vitest";
import { ResourceTracker } from "./resources";

describe("ResourceTracker", () => {
  it("counts open resources per kind and keeps released kinds at zero", () => {
    const resources = new ResourceTracker();
    const releaseA = resources.acquire("timer");
    resources.acquire("timer");
    const releaseC = resources.acquire("ws.connection");

    releaseA();
    releaseC();

    expect(resources.snapshot()).toStrictEqual({ timer: 1, "ws.connection": 0 });
  });

  it("lists kinds in alphabetical order so snapshots read the same every time", () => {
    const resources = new ResourceTracker();
    resources.acquire("ws.connection");
    resources.acquire("span");
    resources.acquire("timer");

    expect(Object.keys(resources.snapshot())).toStrictEqual(["span", "timer", "ws.connection"]);
  });

  it("ignores a second release of the same resource", () => {
    const resources = new ResourceTracker();
    const release = resources.acquire("timer");
    resources.acquire("timer");

    release();
    release();

    expect(resources.snapshot()).toStrictEqual({ timer: 1 });
  });
});
