import { describe, expect, it, onTestFinished } from "vitest";
import { createHighlighter } from "./highlight";

/**
 * A way to start a worker running the script given.
 *
 * @sideEffects Makes an object URL, revoked as the test finishes.
 * @param script - The worker's script.
 * @returns How to start it.
 */
function workerOf(script: string): () => Worker {
  const url = URL.createObjectURL(new Blob([script], { type: "text/javascript" }));
  onTestFinished(() => URL.revokeObjectURL(url));
  return () => new Worker(url);
}

/**
 * Starts the workers given in turn, the last one again after the others.
 *
 * @sideEffects Terminates the workers started as the test finishes.
 * @param starts - How to start each.
 * @returns How to start the next, and those started.
 */
function inTurn(...starts: [() => Worker, ...(() => Worker)[]]) {
  const started: Worker[] = [];
  onTestFinished(() => {
    for (const worker of started) worker.terminate();
  });
  /**
   * Starts the next worker.
   *
   * @sideEffects Starts a worker.
   * @returns It.
   */
  const start = (): Worker => {
    const worker = (starts.length > 1 ? starts.shift() : undefined) ?? starts[0];
    const made = worker();
    started.push(made);
    return made;
  };
  return { start, started };
}

describe("createHighlighter", () => {
  it("lets the texts waiting go without colours when its worker fails, and starts another for the next", async () => {
    const { start, started } = inTurn(
      workerOf("self.onmessage = () => { throw new Error('broken'); };"),
      workerOf("self.onmessage = (event) => self.postMessage({ id: event.data.id, texts: [] });"),
    );
    const highlight = createHighlighter(start);

    const failed = await highlight("a.ts", ["x"]);
    const after = await highlight("a.ts", ["x"]);

    expect([failed, after, started.length]).toStrictEqual([null, [], 2]);
  });
});
