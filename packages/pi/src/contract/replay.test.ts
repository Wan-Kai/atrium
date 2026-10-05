import { type FixtureRecord, type JsonObject, parseFixture, replayPi } from "@atrium/testkit";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FIXTURES_DIR } from "../../test/contract";

const files = readdirSync(FIXTURES_DIR, { recursive: true, encoding: "utf8" })
  .filter((name) => name.endsWith(".jsonl"))
  .toSorted();

/**
 * Drives a replay with exactly what the scenario sent, and says what came out and what should have.
 *
 * @remarks
 * Dialog answers go through `respond`, everything else through `request`; a requested exit needs
 * `stop()`, a crash ends on its own.
 *
 * @sideEffects none
 * @param fixture - A recorded fixture.
 * @returns The events delivered, the exit, unplayed records, and the expected events and exit code.
 */
async function playBack(fixture: readonly FixtureRecord[]) {
  const pi = replayPi(fixture);
  const events: JsonObject[] = [];
  pi.onEvent((event) => events.push(event));
  const sends = fixture.flatMap((record) => (record.kind === "send" ? [record.record] : []));
  const responses: Promise<unknown>[] = [];
  for (const record of sends) {
    if (record["type"] === "extension_ui_response") pi.respond(record);
    else responses.push(pi.request(record as { type: string }).catch((error: unknown) => error));
  }
  const exit = fixture.find((record) => record.kind === "exit");
  const ended = exit?.requested === true ? await pi.stop() : await pi.exited;
  await Promise.all(responses);
  const answered = new Set(sends.map((record) => record["id"]));
  const expectedEvents = fixture.flatMap((record) =>
    record.kind === "stdout" && !(record.record["type"] === "response" && answered.has(record.record["id"]))
      ? [record.record]
      : [],
  );
  return { events, ended, remaining: pi.remaining(), expectedEvents, expectedCode: exit?.code };
}

describe("recorded fixtures", () => {
  it("exist for every contract scenario", () => {
    expect(files.length).toBeGreaterThanOrEqual(12);
  });

  it.each(files)("%s plays back exactly as recorded", async (file) => {
    const played = await playBack(parseFixture(readFileSync(join(FIXTURES_DIR, file), "utf8")));

    expect(played.events).toStrictEqual(played.expectedEvents);
    expect(played.ended.code).toBe(played.expectedCode);
    expect(played.remaining).toBe(0);
  });
});
