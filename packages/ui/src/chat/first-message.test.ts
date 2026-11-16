import { describe, expect, it } from "vitest";
import { createFirstMessages, firstMessages } from "./first-message";

/**
 * Lets every pending continuation run.
 *
 * @sideEffects Schedules a timer.
 * @returns When the macrotask queue reached it.
 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("first messages (SPEC-0008, 真实模型检查后改)", () => {
  it("lets a session nothing holds go at once", async () => {
    const first = createFirstMessages();
    let gone = false;
    void first.after("s1").then(() => (gone = true));
    await settle();
    expect(gone).toBe(true);
  });

  it("holds later messages until released, then lets them go in the order they waited, other sessions untouched", async () => {
    const first = createFirstMessages();
    const release = first.hold("s1");
    const order: string[] = [];
    void first.after("s1").then(() => order.push("second"));
    void first.after("s1").then(() => order.push("third"));
    void first.after("s2").then(() => order.push("other"));
    await settle();
    expect(order).toStrictEqual(["other"]);

    release();
    await settle();

    expect(order).toStrictEqual(["other", "second", "third"]);
    // Released once and for all: later messages go at once, and releasing again changes nothing.
    release();
    let later = false;
    void first.after("s1").then(() => (later = true));
    await settle();
    expect(later).toBe(true);
  });

  it("waits for both holds on one session, whichever ends first", async () => {
    const first = createFirstMessages();
    const one = first.hold("s1");
    const two = first.hold("s1");
    let gone = false;
    void first.after("s1").then(() => (gone = true));

    two();
    await settle();
    expect(gone).toBe(false);
    one();
    await settle();
    expect(gone).toBe(true);
  });

  it("keeps a later hold when an earlier one ends", async () => {
    const first = createFirstMessages();
    const one = first.hold("s1");
    const two = first.hold("s1");
    one();
    await settle();
    let gone = false;
    void first.after("s1").then(() => (gone = true));
    await settle();
    expect(gone).toBe(false);
    two();
    await settle();
    expect(gone).toBe(true);
  });

  it("is one for the page", () => {
    expect(firstMessages()).toBe(firstMessages());
  });
});
