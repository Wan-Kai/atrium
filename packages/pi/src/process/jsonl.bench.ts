import { compareWithBaseline } from "@atrium/testkit";
import { expect, test } from "vitest";
import { createLineSplitter } from "./jsonl";

const CHUNK = 64 * 1024;

/** Pushes `bytes` through a fresh splitter in pipe-sized chunks. */
function splitInChunks(bytes: Buffer): void {
  const splitter = createLineSplitter(() => undefined);
  for (let offset = 0; offset < bytes.length; offset += CHUNK) splitter.push(bytes.subarray(offset, offset + CHUNK));
  splitter.end();
}

const streamingUpdates = Buffer.from(
  Array.from(
    { length: 20_000 },
    (_, index) => `${JSON.stringify({ type: "message_update", index, delta: "streamed text 流式 😀" })}\n`,
  ).join(""),
);

const oneLargeResponse = Buffer.from(`${JSON.stringify({ type: "response", data: "x".repeat(16 * 1024 * 1024) })}\n`);

test("splitting many small streaming records stays near its baseline speed", async ({ bench }) => {
  const ratio = await compareWithBaseline(bench, "small records", ".bench/pi/jsonl-small-records.json", () =>
    splitInChunks(streamingUpdates),
  );

  expect(ratio).toBeLessThan(3);
});

test("splitting one 16 MiB record stays near its baseline speed", async ({ bench }) => {
  // Rescanning the whole buffer on every chunk, as pi's own reader does, is about 60 times slower here.
  const ratio = await compareWithBaseline(bench, "large record", ".bench/pi/jsonl-large-record.json", () =>
    splitInChunks(oneLargeResponse),
  );

  expect(ratio).toBeLessThan(3);
});
