import {
  type FauxScript,
  type FixtureRecord,
  type JsonObject,
  comparable,
  createNormalizer,
  createRecorder,
  createTempDir,
  fauxPi,
  parseFixture,
  present,
  serializeFixture,
} from "@atrium/testkit";
import { mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, vi } from "vitest";
import type { PiDeps } from "../src/deps";
import { findPi, readVersion } from "../src/locate/locate";
import { type PiEvent, type PiProcess, startPiProcess } from "../src/process/pi-process";

/** Where fixtures live, one directory per pi version (testing.md, "pi 夹具"). */
export const FIXTURES_DIR = join(import.meta.dirname, "..", "fixtures");

/** What a scenario body works with. */
export interface ScenarioContext {
  readonly pi: PiProcess;
  /** Every event pi printed so far, in order. */
  readonly events: PiEvent[];
  /** The working directory, also pi's HOME. */
  readonly cwd: string;
  /** Where pi writes session files, when the scenario uses them. */
  readonly sessionsDir: string;
  /** Lets a faux reply scripted with `waitFor: name` continue. */
  readonly release: (name: string) => Promise<void>;
  /** Waits until pi has printed an event matching `predicate` and returns it. */
  readonly until: (predicate: (event: PiEvent) => boolean) => Promise<PiEvent>;
  /**
   * Waits until pi has printed the `count`-th user message, the last record before a held faux
   * reply starts streaming; anything sent then lands at a fixed place in the fixture.
   */
  readonly heldAfterUserMessage: (count: number) => Promise<void>;
  /** The bodies of the requests pi made so far, as its extensions left them. */
  readonly payloads: () => Promise<unknown[]>;
}

/**
 * Dependencies for contract runs.
 *
 * @remarks
 * Request ids are sequential (`r1`, `r2`, …) so fixtures are stable without normalizing them,
 * and nothing is logged, since the fixture is the record.
 *
 * @sideEffects none; the returned clock schedules real timers.
 * @param env - pi's environment.
 * @returns The dependencies.
 */
function contractDeps(env: Readonly<Record<string, string>>): PiDeps {
  let next = 0;
  return {
    clock: {
      now: () => Date.now(),
      setTimeout(callback, ms) {
        const timer = setTimeout(callback, ms);
        return () => clearTimeout(timer);
      },
    },
    track: () => () => undefined,
    log: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
    nextRequestId: () => `r${++next}`,
    env,
  };
}

/**
 * Reads every session file pi wrote, as parsed lines in file order.
 *
 * @remarks
 * Appended to the fixture so M1.4's history mapping can be tested against real files.
 *
 * @sideEffects Reads files.
 * @param sessionsDir - Where pi wrote them.
 * @returns The lines, header and entries.
 */
async function sessionLines(sessionsDir: string): Promise<JsonObject[]> {
  const files = (await readdir(sessionsDir, { recursive: true })).filter((name) => name.endsWith(".jsonl")).toSorted();
  const lines: JsonObject[] = [];
  for (const file of files) {
    for (const line of (await readFile(join(sessionsDir, file), "utf8")).split("\n")) {
      if (line !== "") lines.push(JSON.parse(line) as JsonObject);
    }
  }
  return lines;
}

/**
 * Runs one contract scenario against real pi, then records or checks its fixture.
 *
 * @remarks
 * Layer 3 of the test plan (testing.md, "pi 夹具"): the body asserts pi's behavior, and the traffic
 * becomes the fixture layer 1 replays. With `RECORD_FIXTURES=1` the fixture is (re)written;
 * otherwise the normalized traffic must match the stored fixture for the installed pi version,
 * apart from machine-specific parts, so a pi upgrade cannot slip past unreviewed.
 *
 * @sideEffects Creates and deletes a temporary directory; runs pi; reads or writes the fixture file.
 * @param options - Scenario name, faux script, whether to keep a session file, pi settings,
 * files to put in place first, Atrium's own extensions for pi to load, and more environment.
 * @param body - The scenario's steps and assertions.
 * @returns The recorded records.
 */
export async function runScenario(
  options: {
    readonly scenario: string;
    readonly script: FauxScript;
    readonly session?: boolean;
    /** Contents of pi's `settings.json`, such as compaction thresholds. */
    readonly settings?: object;
    /** Files to write before pi starts, by path relative to the working directory. */
    readonly files?: Readonly<Record<string, string>>;
    readonly extensions?: readonly string[];
    /** Variables added to pi's environment; the fixture has each value as `<NAME>`. */
    readonly env?: Readonly<Record<string, string>>;
  },
  body: (context: ScenarioContext) => Promise<void>,
): Promise<FixtureRecord[]> {
  const dir = await createTempDir("contract");
  try {
    const cwd = await realpath(dir.path);
    const launch = await fauxPi(options.script, cwd);
    if (options.settings !== undefined) {
      await writeFile(join(cwd, "pi-agent", "settings.json"), JSON.stringify(options.settings));
    }
    for (const [path, content] of Object.entries(options.files ?? {})) {
      await mkdir(dirname(join(cwd, path)), { recursive: true });
      await writeFile(join(cwd, path), content);
    }
    const path = present(process.env["PATH"], "PATH");
    const piPath = present(await findPi(path), "pi on PATH");
    const version = present(await readVersion(piPath, { env: process.env }), "pi version").join(".");
    const sessionsDir = join(cwd, "sessions");
    await mkdir(sessionsDir);
    const sessionArgs = options.session === true ? ["--session-dir", sessionsDir] : ["--no-session"];
    const extension = present(launch.args[1], "faux extension path");
    const normalize = createNormalizer({
      [sessionsDir]: "<sessions>",
      [join(cwd, "pi-agent")]: "<agent>",
      [cwd]: "<cwd>",
      [dir.path]: "<cwd>",
      [dirname(extension)]: "<faux>",
      ...Object.fromEntries((options.extensions ?? []).map((atrium) => [dirname(atrium), "<atrium>"])),
      // Values given for this run, such as a local server's address, go by their variable's name.
      ...Object.fromEntries(Object.entries(options.env ?? {}).map(([name, value]) => [value, `<${name}>`])),
      // The system prompt names pi's own install paths, which sit under the real home directory.
      [homedir()]: "<home>",
    });
    const recorder = createRecorder(
      {
        scenario: options.scenario,
        pi: version,
        script: options.script,
        args: sessionArgs.map((arg) => arg.replace(sessionsDir, "<sessions>")),
      },
      normalize,
    );
    const pi = startPiProcess(
      {
        piPath,
        args: [
          ...sessionArgs,
          ...launch.args,
          ...(options.extensions ?? []).flatMap((atrium) => ["--extension", atrium]),
        ],
        cwd,
        env: { ...launch.env, ...options.env },
      },
      // TMPDIR too, so pi's own temporary files land in the run's directory, which is cleaned up.
      contractDeps({ PATH: path, HOME: cwd, TMPDIR: tmpdir() }),
      { tap: recorder.tap },
    );
    const events: PiEvent[] = [];
    pi.onEvent((event) => events.push(event));
    try {
      await body({
        pi,
        events,
        cwd,
        sessionsDir,
        release: (name) => launch.release(name),
        payloads: () => launch.payloads(),
        until: (predicate) =>
          vi.waitFor(() => present(events.find(predicate), "the expected event"), { timeout: 20_000, interval: 10 }),
        heldAfterUserMessage: async (count) => {
          await vi.waitFor(
            () =>
              expect(
                events.filter((event) => event.type === "message_end" && event.message.role === "user"),
              ).toHaveLength(count),
            { timeout: 20_000, interval: 10 },
          );
        },
      });
    } finally {
      const exit = await pi.stop();
      recorder.exit(exit.code, exit.signal, exit.requested);
    }
    if (options.session === true) recorder.session(await sessionLines(sessionsDir));
    const records = recorder.records();
    await recordOrCheck(options.scenario, version, records);
    return records;
  } finally {
    await dir.cleanup();
  }
}

/**
 * Writes the fixture when recording; otherwise checks the run against it.
 *
 * @remarks
 * A missing fixture fails too: running against an unrecorded pi version must not pass silently.
 *
 * @sideEffects Writes or reads the fixture file.
 * @param scenario - Scenario name, the file name.
 * @param version - pi's version, the directory name.
 * @param records - What this run recorded.
 */
async function recordOrCheck(scenario: string, version: string, records: readonly FixtureRecord[]): Promise<void> {
  const file = join(FIXTURES_DIR, `pi-${version}`, `${scenario}.jsonl`);
  if (process.env["RECORD_FIXTURES"] === "1") {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, serializeFixture(records));
    return;
  }
  const stored = await readFile(file, "utf8").catch(() => undefined);
  if (stored === undefined) {
    throw new Error(`no fixture ${file} for pi ${version}; run pnpm fixtures:record and review the diff`);
  }
  expect(
    comparable(records),
    `pi's output differs from ${file}; run pnpm fixtures:record and review the diff`,
  ).toStrictEqual(comparable(parseFixture(stored)));
}
