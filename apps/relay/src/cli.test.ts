import { createTempDir, FakeClock } from "@atrium/testkit";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { Peer } from "../test/peers";
import { type CliIo, HOSTS_POLL_MS, parseListen, runCli, USAGE_INTERVAL_MS } from "./cli";
import { hashToken, hostsPath, readHosts } from "./hosts";
import { RelayClose } from "./relay";

const LINE = /^atrium-relay:\/\/(hst_[0-9a-f]{16}):([A-Za-z0-9_-]{43})@relay\.test\/atrium$/;

/** What a test reads back from a command. */
interface Run {
  readonly code: number;
  readonly stdout: string[];
  readonly stderr: string[];
}

/**
 * A data directory with a `relay.json`, removed after the test.
 *
 * @remarks
 * The prefix is `/atrium`, as on the user's VPS.
 *
 * @sideEffects Creates a directory and a file.
 * @param config - The file's content, or null for none.
 * @returns The directory.
 */
async function dataDir(config: object | null = { publicHost: "relay.test", pathPrefix: "/atrium" }): Promise<string> {
  const dir = await createTempDir("relay-cli");
  onTestFinished(dir.cleanup);
  if (config !== null) await writeFile(join(dir.path, "relay.json"), JSON.stringify(config));
  return dir.path;
}

/**
 * Runs one command with captured output.
 *
 * @remarks
 * In process, so `serve` runs on the fake clock.
 *
 * @sideEffects As the command.
 * @param argv - The arguments.
 * @param overrides - Parts of the io to replace.
 * @returns The exit code and the output.
 */
async function run(argv: string[], overrides: Partial<CliIo> = {}): Promise<Run> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runCli(argv, {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
    env: {},
    cwd: "/",
    clock: new FakeClock(Date.parse("2026-10-25T08:00:00.000Z")),
    signal: AbortSignal.abort(),
    ...overrides,
  });
  return { code, stdout, stderr };
}

/**
 * The host id and token in a printed line.
 *
 * @remarks
 * Fails the test when the line is not one.
 *
 * @sideEffects none
 * @param line - The line.
 * @returns Its parts.
 */
function partsOf(line: string | undefined): { hostId: string; token: string } {
  const match = LINE.exec(line ?? "");
  expect(match).not.toBeNull();
  return { hostId: match?.[1] ?? "", token: match?.[2] ?? "" };
}

/**
 * The names in the host table.
 *
 * @remarks
 * Fails when the table is not valid.
 *
 * @sideEffects Reads the file.
 * @param dir - The data directory.
 * @returns The names, in order.
 */
async function hostNames(dir: string): Promise<string[]> {
  const read = await readHosts(dir);
  if (!read.ok) throw new Error("host table is not valid");
  return read.hosts.map((host) => host.name);
}

/**
 * The names and token hashes in the host table.
 *
 * @remarks
 * Fails when the table is not valid.
 *
 * @sideEffects Reads the file.
 * @param dir - The data directory.
 * @returns Name and hash pairs.
 */
async function hostHashes(dir: string): Promise<string[][]> {
  const read = await readHosts(dir);
  if (!read.ok) throw new Error("host table is not valid");
  return read.hosts.map((host) => [host.name, host.tokenSha256]);
}

describe("atrium-relay add-host", () => {
  it("prints exactly one line with a new id and token, and stores only the token's hash", async () => {
    const dir = await dataDir();

    const result = await run(["add-host", "My Mac", "--dir", dir]);

    expect(result.code).toBe(0);
    expect(result.stderr).toStrictEqual([]);
    expect(result.stdout).toHaveLength(1);
    const { hostId, token } = partsOf(result.stdout[0]);
    expect(await readHosts(dir)).toStrictEqual({
      ok: true,
      hosts: [{ hostId, name: "My Mac", tokenSha256: hashToken(token), createdAt: "2026-10-25T08:00:00.000Z" }],
    });
    expect(await readFile(hostsPath(dir), "utf8")).not.toContain(token);
    expect((await stat(hostsPath(dir))).mode & 0o777).toBe(0o600);
  });

  it("adds to the hosts already there", async () => {
    const dir = await dataDir();
    await run(["add-host", "one", "--dir", dir]);

    await run(["add-host", "two", "--dir", dir]);

    expect(await hostNames(dir)).toStrictEqual(["one", "two"]);
  });

  it("takes the directory from ATRIUM_RELAY_DIR, relative to the working directory", async () => {
    const dir = await dataDir();

    const result = await run(["add-host", "Mac"], { env: { ATRIUM_RELAY_DIR: "." }, cwd: dir });

    expect(result.code).toBe(0);
    expect(await hostNames(dir)).toStrictEqual(["Mac"]);
  });

  it.each(["", "x".repeat(65), "bad\nname"])("refuses the name %j", async (name) => {
    const dir = await dataDir();

    const result = await run(["add-host", name, "--dir", dir]);

    expect(result.code).toBe(2);
    expect(result.stdout).toStrictEqual([]);
    expect(await readdir(dir)).toStrictEqual(["relay.json"]);
  });

  it("needs relay.json and says where it is missing", async () => {
    const dir = await dataDir(null);

    const result = await run(["add-host", "Mac", "--dir", dir]);

    expect(result).toStrictEqual({
      code: 2,
      stdout: [],
      stderr: [`${join(dir, "relay.json")} is missing; see apps/relay/README.md`],
    });
  });

  it("names the bad fields of relay.json", async () => {
    const dir = await dataDir({ publicHost: "relay.test", extra: 1 });

    const result = await run(["add-host", "Mac", "--dir", dir]);

    expect(result.code).toBe(2);
    expect(result.stderr).toStrictEqual([`${join(dir, "relay.json")} is not valid: extra`]);
  });

  it("says when relay.json is not JSON", async () => {
    const dir = await dataDir(null);
    await writeFile(join(dir, "relay.json"), "{");

    const result = await run(["add-host", "Mac", "--dir", dir]);

    expect(result.stderr).toStrictEqual([`${join(dir, "relay.json")} is not valid: not JSON`]);
  });

  it("does not overwrite a broken host table", async () => {
    const dir = await dataDir();
    await writeFile(hostsPath(dir), "{broken");

    const result = await run(["add-host", "Mac", "--dir", dir]);

    expect(result.code).toBe(2);
    expect(result.stderr).toStrictEqual([`${hostsPath(dir)} is not a valid host table; fix or remove it`]);
    expect(await readFile(hostsPath(dir), "utf8")).toBe("{broken");
  });
});

describe("atrium-relay rotate-host, remove-host, list-hosts", () => {
  it("gives a host a new token and prints the new line once", async () => {
    const dir = await dataDir();
    const old = partsOf((await run(["add-host", "Mac", "--dir", dir])).stdout[0]);

    const result = await run(["rotate-host", old.hostId, "--dir", dir]);

    expect(result.code).toBe(0);
    expect(result.stdout).toHaveLength(1);
    const fresh = partsOf(result.stdout[0]);
    expect(fresh.hostId).toBe(old.hostId);
    expect(fresh.token).not.toBe(old.token);
    expect(await hostHashes(dir)).toStrictEqual([["Mac", hashToken(fresh.token)]]);
  });

  it("removes a host and keeps the others", async () => {
    const dir = await dataDir();
    const one = partsOf((await run(["add-host", "one", "--dir", dir])).stdout[0]);
    await run(["add-host", "two", "--dir", dir]);

    const result = await run(["remove-host", one.hostId, "--dir", dir]);

    expect(result).toStrictEqual({ code: 0, stdout: [`removed ${one.hostId}`], stderr: [] });
    expect(await hostNames(dir)).toStrictEqual(["two"]);
  });

  it.each(["rotate-host", "remove-host"])(
    "%s says when there is no such host, without echoing odd input",
    async (command) => {
      const dir = await dataDir();
      await run(["add-host", "Mac", "--dir", dir]);

      const unknown = await run([command, "hst_0000000000000000", "--dir", dir]);
      const odd = await run([command, "../../etc", "--dir", dir]);

      expect(unknown).toStrictEqual({ code: 1, stdout: [], stderr: ["no host hst_0000000000000000"] });
      expect(odd).toStrictEqual({ code: 1, stdout: [], stderr: ["no host with that id"] });
    },
  );

  it("rotate-host needs relay.json; remove-host refuses a broken table", async () => {
    const noConfig = await dataDir(null);
    const broken = await dataDir();
    await writeFile(hostsPath(broken), "{");

    expect((await run(["rotate-host", "hst_0000000000000000", "--dir", noConfig])).code).toBe(2);
    expect((await run(["remove-host", "hst_0000000000000000", "--dir", broken])).code).toBe(2);
    expect((await run(["list-hosts", "--dir", broken])).code).toBe(2);
  });

  it("lists ids, names and creation times, never tokens", async () => {
    const dir = await dataDir();
    const { hostId, token } = partsOf((await run(["add-host", "Mac", "--dir", dir])).stdout[0]);

    const result = await run(["list-hosts", "--dir", dir]);

    expect(result).toStrictEqual({ code: 0, stdout: [`${hostId}\tMac\t2026-10-25T08:00:00.000Z`], stderr: [] });
    expect(result.stdout.join("")).not.toContain(token);
  });
});

describe("atrium-relay usage", () => {
  it.each([
    [[]],
    [["help"]],
    [["add-host"]],
    [["add-host", "a", "b"]],
    [["rotate-host"]],
    [["remove-host"]],
    [["list-hosts", "x"]],
    [["serve", "x"]],
    [["serve", "--listen", "nope"]],
    [["list-hosts", "--unknown"]],
  ])("prints the usage and exits 2 for %j", async (argv) => {
    const result = await run(argv, { cwd: await dataDir() });

    expect(result.code).toBe(2);
    expect(result.stdout).toStrictEqual([]);
    expect(result.stderr[0]).toMatch(/^usage: atrium-relay <command>/);
  });

  it("parses listen addresses", () => {
    expect(parseListen("127.0.0.1:8787")).toStrictEqual({ host: "127.0.0.1", port: 8787 });
    expect(parseListen("[::1]:0")).toStrictEqual({ host: "::1", port: 0 });
    expect(parseListen("localhost:65535")).toStrictEqual({ host: "localhost", port: 65_535 });
    expect(parseListen("127.0.0.1:65536")).toBeNull();
    expect(parseListen("127.0.0.1")).toBeNull();
    expect(parseListen("::1:80")).toBeNull();
  });
});

/**
 * Runs `serve` on a free port until the test aborts it.
 *
 * @remarks
 * The fake clock drives the host-table polls and the usage log.
 *
 * @sideEffects Listens on a port; writes logs in `dir`.
 * @param dir - The data directory.
 * @param env - Environment for the command.
 * @returns The port, the clock, the stop function and the command's result.
 */
async function serve(
  dir: string,
  env: Record<string, string> = {},
): Promise<{ port: number; clock: FakeClock; stop: () => Promise<Run>; stdout: string[] }> {
  const clock = new FakeClock(Date.parse("2026-10-25T08:00:00.000Z"));
  const controller = new AbortController();
  const listening = Promise.withResolvers<number>();
  const stdout: string[] = [];
  const stderr: string[] = [];
  const done = runCli(["serve", "--dir", dir], {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
    env: { ATRIUM_RELAY_LISTEN: "127.0.0.1:0", ...env },
    cwd: "/",
    clock,
    signal: controller.signal,
    memory: () => ({ rss: 1, heapUsed: 2 }),
    onListening: listening.resolve,
  });
  let stopped: Promise<Run> | null = null;
  const stop = (): Promise<Run> => {
    stopped ??= (async () => {
      controller.abort();
      return { code: await done, stdout, stderr };
    })();
    return stopped;
  };
  onTestFinished(async () => {
    await stop();
  });
  return { port: await listening.promise, clock, stop, stdout };
}

/**
 * Every record of the relay's log files.
 *
 * @remarks
 * Read after `serve` stopped, so the files are flushed.
 *
 * @sideEffects Reads files.
 * @param dir - The data directory.
 * @returns The records, in order.
 */
async function logRecords(dir: string): Promise<Array<Record<string, unknown>>> {
  const names = (await readdir(join(dir, "logs"))).toSorted();
  const texts = await Promise.all(names.map((name) => readFile(join(dir, "logs", name), "utf8")));
  return texts.flatMap((text) =>
    text
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>),
  );
}

/**
 * Waits until today's log has `count` lines of `event`.
 *
 * @remarks
 * The host-table polls run in the background; tests wait for their effect before going on.
 *
 * @sideEffects Reads the log file.
 * @param dir - The data directory.
 * @param event - The event name.
 * @param count - How many lines.
 * @returns Once there.
 */
async function waitForLog(dir: string, event: string, count = 1): Promise<void> {
  await vi.waitFor(async () => {
    const text = await readFile(join(dir, "logs", "relay-2026-10-25.jsonl"), "utf8").catch(() => "");
    expect(text.split("\n").filter((line) => line.includes(`"event":"${event}"`))).toHaveLength(count);
  });
}

describe("atrium-relay serve", () => {
  it("serves the hosts of the table, logs to the data directory and stops cleanly on the signal", async () => {
    const dir = await dataDir();
    const { hostId, token } = partsOf((await run(["add-host", "Mac", "--dir", dir])).stdout[0]);
    const relay = await serve(dir);
    await waitForLog(dir, "hosts_loaded");
    const control = new Peer(`ws://127.0.0.1:${relay.port}/atrium/v1/host`);
    await control.opened;

    control.sendJson({ v: 1, type: "hello", hostId, token });
    expect(await control.json()).toStrictEqual({ type: "ready" });
    const result = await relay.stop();

    expect(result.code).toBe(0);
    expect(result.stdout).toStrictEqual([`atrium-relay listening on 127.0.0.1:${relay.port}/atrium`]);
    expect((await control.closed).code).toBe(1001);
    const records = await logRecords(dir);
    expect(records.map((record) => record["event"])).toStrictEqual([
      "listening",
      "hosts_loaded",
      "host_online",
      "host_offline",
      "stopped",
    ]);
    expect(JSON.stringify(records)).not.toContain(token);
  });

  it("cuts a host off within one poll of rotate-host and accepts the new token", async () => {
    const dir = await dataDir();
    const old = partsOf((await run(["add-host", "Mac", "--dir", dir])).stdout[0]);
    const relay = await serve(dir);
    await waitForLog(dir, "hosts_loaded");
    const control = new Peer(`ws://127.0.0.1:${relay.port}/atrium/v1/host`);
    await control.opened;
    control.sendJson({ v: 1, type: "hello", hostId: old.hostId, token: old.token });
    await control.json();

    const fresh = partsOf((await run(["rotate-host", old.hostId, "--dir", dir])).stdout[0]);
    relay.clock.advance(HOSTS_POLL_MS);

    expect((await control.closed).code).toBe(RelayClose.Unauthorized);
    const again = new Peer(`ws://127.0.0.1:${relay.port}/atrium/v1/host`);
    await again.opened;
    again.sendJson({ v: 1, type: "hello", hostId: fresh.hostId, token: fresh.token });
    expect(await again.json()).toStrictEqual({ type: "ready" });
    await relay.stop();
    expect(JSON.stringify(await logRecords(dir))).not.toContain(fresh.token);
  });

  it("learns hosts added while it runs and keeps the last good table when the file breaks", async () => {
    const dir = await dataDir();
    const relay = await serve(dir);
    await waitForLog(dir, "hosts_loaded");
    const { hostId, token } = partsOf((await run(["add-host", "Mac", "--dir", dir])).stdout[0]);
    relay.clock.advance(HOSTS_POLL_MS);
    await waitForLog(dir, "hosts_loaded", 2);

    await writeFile(hostsPath(dir), "{broken");
    relay.clock.advance(HOSTS_POLL_MS);
    await waitForLog(dir, "hosts_invalid");
    const control = new Peer(`ws://127.0.0.1:${relay.port}/atrium/v1/host`);
    await control.opened;
    control.sendJson({ v: 1, type: "hello", hostId, token });

    expect(await control.json()).toStrictEqual({ type: "ready" });
  });

  it("logs the resource counts and memory every minute", async () => {
    const dir = await dataDir();
    const relay = await serve(dir);

    relay.clock.advance(USAGE_INTERVAL_MS);
    relay.clock.advance(USAGE_INTERVAL_MS);
    await relay.stop();

    const usage = (await logRecords(dir)).filter((record) => record["event"] === "resource_usage");
    expect(usage).toHaveLength(2);
    expect(usage[0]).toMatchObject({ level: "info", rss: 1, heapUsed: 2, counts: { "log.file": 1 } });
  });

  it("does not start without relay.json or with a broken host table", async () => {
    const noConfig = await dataDir(null);
    const broken = await dataDir();
    await writeFile(hostsPath(broken), "{");

    expect((await run(["serve", "--dir", noConfig])).code).toBe(2);
    expect((await run(["serve", "--dir", broken])).code).toBe(2);
    expect(await readdir(broken)).toStrictEqual(["hosts.json", "relay.json"]);
  });

  it("fails when the port is taken, closing its log", async () => {
    const dir = await dataDir();
    const first = await serve(dir);

    await expect(run(["serve", "--dir", dir, "--listen", `127.0.0.1:${first.port}`])).rejects.toThrow("EADDRINUSE");
  });

  it("stops at once when the signal is already aborted", async () => {
    const dir = await dataDir();

    const result = await run(["serve", "--dir", dir, "--listen", "127.0.0.1:0"]);

    expect(result.code).toBe(0);
    expect(result.stdout[0]).toMatch(/^atrium-relay listening on 127\.0\.0\.1:\d+\/atrium$/);
  });
});
