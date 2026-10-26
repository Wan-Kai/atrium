import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { Clock } from "./clock";
import { trackedTimeout } from "./clock";
import { type RelayConfig, loadConfig, relayLine } from "./config";
import { DailyLog } from "./daily-log";
import { errorCode } from "./errors";
import { HOST_ID, type HostRecord, hashToken, newCredentials, readHosts, watchHosts, writeHosts } from "./hosts";
import { type RelayLimits, startRelay } from "./relay";
import { ResourceTracker } from "./resources";

/** What the command line is given by `entry.ts`, or by a test. */
export interface CliIo {
  /** Writes one line to standard output. */
  readonly stdout: (line: string) => void;
  /** Writes one line to standard error. */
  readonly stderr: (line: string) => void;
  /** The environment: `ATRIUM_RELAY_DIR`, `ATRIUM_RELAY_LISTEN`. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Where relative directories start. */
  readonly cwd: string;
  readonly clock: Clock;
  /** Stops `serve`. */
  readonly signal: AbortSignal;
  /** Reports memory for the minutely usage line; tests pass a fixed one. */
  readonly memory?: () => { rss: number; heapUsed: number };
  /** For tests: smaller limits. */
  readonly limits?: Partial<RelayLimits>;
  /** Tells a test the port `serve` listens on. */
  readonly onListening?: (port: number) => void;
}

/** How often the serving relay looks at `hosts.json` (SPEC-0005, "部署 relay" item 1). */
export const HOSTS_POLL_MS = 2_000;
/** How often the resource counts and memory are logged. */
export const USAGE_INTERVAL_MS = 60_000;
const DEFAULT_LISTEN = "127.0.0.1:8787";

const USAGE = `usage: atrium-relay <command> [--dir <dir>] [--listen <host:port>]

commands:
  serve                 run the relay (stops on SIGTERM or SIGINT)
  add-host <name>       add a host and print its atrium-relay:// line once
  rotate-host <hostId>  give a host a new token and print the new line once
  remove-host <hostId>  remove a host
  list-hosts            list hosts (no tokens)

--dir defaults to $ATRIUM_RELAY_DIR or the current directory; it holds relay.json, hosts.json
and logs/. --listen defaults to $ATRIUM_RELAY_LISTEN or ${DEFAULT_LISTEN}.`;

/**
 * Runs one relay command.
 *
 * @remarks
 * The commands that change `hosts.json` run as separate processes next to the serving relay (in
 * Docker, `docker exec`), which notices the change within two seconds (SPEC-0005, "部署 relay").
 * A token is printed exactly once, to standard output, and goes nowhere else (security.md,
 * "relay"). Two commands changing the table at the same moment can lose one change; one person
 * runs them by hand, so there is no lock.
 *
 * @sideEffects Reads and writes the data directory; `serve` listens on a port, writes logs and
 * schedules timers until the signal aborts; writes to stdout and stderr.
 * @param argv - Arguments after the program name.
 * @param io - Output, environment, clock and stop signal.
 * @returns The exit code: 0 done, 1 no such host, 2 usage or configuration error.
 */
export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch {
    io.stderr(USAGE);
    return 2;
  }
  const { command, rest, dirOption, listenOption } = parsed;
  const dir = resolve(io.cwd, dirOption ?? io.env.ATRIUM_RELAY_DIR ?? ".");
  switch (command ?? "") {
    case "serve": {
      const listen = parseListen(listenOption ?? io.env.ATRIUM_RELAY_LISTEN ?? DEFAULT_LISTEN);
      if (listen === null || rest.length > 0) {
        io.stderr(USAGE);
        return 2;
      }
      return serve(dir, listen, io);
    }
    case "add-host":
      return rest.length === 1 && rest[0] !== undefined ? addHost(dir, rest[0], io) : usage(io);
    case "rotate-host":
      return rest.length === 1 && rest[0] !== undefined ? rotateHost(dir, rest[0], io) : usage(io);
    case "remove-host":
      return rest.length === 1 && rest[0] !== undefined ? removeHost(dir, rest[0], io) : usage(io);
    case "list-hosts":
      return rest.length === 0 ? listHosts(dir, io) : usage(io);
    default:
      return usage(io);
  }
}

/**
 * Splits the arguments.
 *
 * @remarks
 * `parseArgs` throws on unknown options, which `runCli` turns into the usage text.
 *
 * @sideEffects none
 * @param argv - The arguments.
 * @returns The command, its positional arguments and the options.
 * @throws On an unknown option or a missing option value.
 */
function parse(argv: readonly string[]): {
  command: string | undefined;
  rest: string[];
  dirOption: string | undefined;
  listenOption: string | undefined;
} {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: { dir: { type: "string" }, listen: { type: "string" } },
  });
  const [command, ...rest] = positionals;
  return { command, rest, dirOption: values.dir, listenOption: values.listen };
}

/**
 * Prints the usage text.
 *
 * @remarks
 * For wrong commands and wrong argument counts.
 *
 * @sideEffects Writes to stderr.
 * @param io - Output.
 * @returns 2.
 */
function usage(io: CliIo): number {
  io.stderr(USAGE);
  return 2;
}

/**
 * Parses `host:port`, with brackets around an IPv6 host.
 *
 * @remarks
 * The relay listens only on a local address in the supported setups; the value is not checked
 * beyond its shape, `listen` reports anything the system refuses.
 *
 * @sideEffects none
 * @param value - Such as `127.0.0.1:8787` or `[::1]:8787`.
 * @returns Host and port, or null.
 */
export function parseListen(value: string): { host: string; port: number } | null {
  const match = /^(?:\[([0-9a-fA-F:.]+)\]|([^:[\]]+)):(\d{1,5})$/.exec(value);
  if (match === null) return null;
  const port = Number(match[3]);
  if (port > 65_535) return null;
  return { host: match[1] ?? match[2] ?? "", port };
}

/**
 * Loads `relay.json`, telling the operator what is wrong when it cannot.
 *
 * @remarks
 * Shared by `serve` and the commands that print a line.
 *
 * @sideEffects Reads the file; writes to stderr on failure.
 * @param dir - The data directory.
 * @param io - Output.
 * @returns The configuration, or null.
 */
async function configOrReport(dir: string, io: CliIo): Promise<RelayConfig | null> {
  const loaded = await loadConfig(dir);
  if (loaded.ok) return loaded.config;
  if (loaded.error.code === "config_missing") {
    io.stderr(`${join(dir, "relay.json")} is missing; see apps/relay/README.md`);
  } else {
    io.stderr(`${join(dir, "relay.json")} is not valid: ${loaded.error.fields.join(", ") || "not JSON"}`);
  }
  return null;
}

/**
 * Reads `hosts.json`, telling the operator when it is not a host table.
 *
 * @remarks
 * A broken table is never overwritten by a command: it would drop every host.
 *
 * @sideEffects Reads the file; writes to stderr on failure.
 * @param dir - The data directory.
 * @param io - Output.
 * @returns The hosts, or null.
 */
async function hostsOrReport(dir: string, io: CliIo): Promise<HostRecord[] | null> {
  const read = await readHosts(dir);
  if (read.ok) return read.hosts;
  io.stderr(`${join(dir, "hosts.json")} is not a valid host table; fix or remove it`);
  return null;
}

/**
 * `add-host <name>`: a new host id and token; prints the line once.
 *
 * @remarks
 * SPEC-0005, "部署 relay" item 4.
 *
 * @sideEffects Writes `hosts.json`; writes the line to stdout.
 * @param dir - The data directory.
 * @param name - The host's name, for `list-hosts`.
 * @param io - Output.
 * @returns The exit code.
 */
async function addHost(dir: string, name: string, io: CliIo): Promise<number> {
  // oxlint-disable-next-line no-control-regex -- control characters are what is refused
  if (name.length === 0 || name.length > 64 || /[\u0000-\u001f\u007f]/.test(name)) {
    io.stderr("the name must be 1 to 64 characters without control characters");
    return 2;
  }
  const config = await configOrReport(dir, io);
  if (config === null) return 2;
  const hosts = await hostsOrReport(dir, io);
  if (hosts === null) return 2;
  const { hostId, token } = newCredentials();
  await writeHosts(dir, [
    ...hosts,
    { hostId, name, tokenSha256: hashToken(token), createdAt: new Date(io.clock.now()).toISOString() },
  ]);
  io.stdout(relayLine(config, hostId, token));
  return 0;
}

/**
 * `rotate-host <hostId>`: a new token; prints the new line once.
 *
 * @remarks
 * The serving relay cuts the host's live connections off within two seconds.
 *
 * @sideEffects Writes `hosts.json`; writes the line to stdout.
 * @param dir - The data directory.
 * @param hostId - The host.
 * @param io - Output.
 * @returns The exit code.
 */
async function rotateHost(dir: string, hostId: string, io: CliIo): Promise<number> {
  const config = await configOrReport(dir, io);
  if (config === null) return 2;
  const hosts = await hostsOrReport(dir, io);
  if (hosts === null) return 2;
  if (!HOST_ID.test(hostId) || !hosts.some((host) => host.hostId === hostId)) {
    io.stderr(`no host ${HOST_ID.test(hostId) ? hostId : "with that id"}`);
    return 1;
  }
  const { token } = newCredentials();
  await writeHosts(
    dir,
    hosts.map((host) => (host.hostId === hostId ? { ...host, tokenSha256: hashToken(token) } : host)),
  );
  io.stdout(relayLine(config, hostId, token));
  return 0;
}

/**
 * `remove-host <hostId>`.
 *
 * @remarks
 * The serving relay cuts the host's live connections off within two seconds.
 *
 * @sideEffects Writes `hosts.json`; writes to stdout.
 * @param dir - The data directory.
 * @param hostId - The host.
 * @param io - Output.
 * @returns The exit code.
 */
async function removeHost(dir: string, hostId: string, io: CliIo): Promise<number> {
  const hosts = await hostsOrReport(dir, io);
  if (hosts === null) return 2;
  if (!HOST_ID.test(hostId) || !hosts.some((host) => host.hostId === hostId)) {
    io.stderr(`no host ${HOST_ID.test(hostId) ? hostId : "with that id"}`);
    return 1;
  }
  await writeHosts(
    dir,
    hosts.filter((host) => host.hostId !== hostId),
  );
  io.stdout(`removed ${hostId}`);
  return 0;
}

/**
 * `list-hosts`: id, name and creation time, tab-separated; never tokens.
 *
 * @remarks
 * The table holds only digests anyway.
 *
 * @sideEffects Reads `hosts.json`; writes to stdout.
 * @param dir - The data directory.
 * @param io - Output.
 * @returns The exit code.
 */
async function listHosts(dir: string, io: CliIo): Promise<number> {
  const hosts = await hostsOrReport(dir, io);
  if (hosts === null) return 2;
  for (const host of hosts) io.stdout(`${host.hostId}\t${host.name}\t${host.createdAt}`);
  return 0;
}

/**
 * `serve`: runs the relay until the signal aborts.
 *
 * @remarks
 * Logs go to `<dir>/logs/` one file per UTC day (SPEC-0005, "可观测性"); only the start line and
 * problems go to the terminal. The host table is polled so `add-host` and friends take effect
 * while it runs; the resource counts and memory are logged every minute (observability.md).
 *
 * @sideEffects Listens on a port; writes logs; schedules timers; writes to stdout and stderr.
 * @param dir - The data directory.
 * @param listen - Where to listen.
 * @param io - Output, clock and the stop signal.
 * @returns The exit code once stopped.
 */
async function serve(dir: string, listen: { host: string; port: number }, io: CliIo): Promise<number> {
  const config = await configOrReport(dir, io);
  if (config === null) return 2;
  const initial = await hostsOrReport(dir, io);
  if (initial === null) return 2;
  const resources = new ResourceTracker();
  const log = new DailyLog(join(dir, "logs"), io.clock, resources, (error) => {
    const code = errorCode(error);
    io.stderr(`log write failed: ${typeof code === "string" ? code : error.name}`);
  });
  await log.open();
  const relay = await startRelay({
    config: config,
    hosts: initial,
    clock: io.clock,
    resources,
    log: (event) => log.write(event),
    listen,
    ...(io.limits === undefined ? {} : { limits: io.limits }),
  }).catch(async (error: unknown) => {
    await log.close();
    throw error;
  });
  log.write({ level: "info", event: "listening", port: relay.port, hosts: initial.length });
  io.stdout(`atrium-relay listening on ${listen.host}:${relay.port}${config.pathPrefix}`);
  io.onListening?.(relay.port);

  const stopWatching = watchHosts(
    dir,
    io.clock,
    resources,
    (hosts) => {
      relay.updateHosts(hosts);
      log.write({ level: "info", event: "hosts_loaded", hosts: hosts.length });
    },
    () => {
      log.write({ level: "warn", event: "hosts_invalid" });
    },
    HOSTS_POLL_MS,
  );
  const memory = io.memory ?? (() => process.memoryUsage());
  let cancelUsage: (() => void) | null = null;
  /**
   * Logs the counts and memory, then schedules the next time.
   *
   * @remarks
   * A rising line in these shows a leak in real use (testing.md, "运行时监控").
   *
   * @sideEffects Writes a log line; schedules a timer.
   */
  const usageTick = (): void => {
    const { rss, heapUsed } = memory();
    log.write({ level: "info", event: "resource_usage", counts: resources.snapshot(), rss, heapUsed });
    cancelUsage = trackedTimeout(io.clock, resources, usageTick, USAGE_INTERVAL_MS);
  };
  cancelUsage = trackedTimeout(io.clock, resources, usageTick, USAGE_INTERVAL_MS);

  if (!io.signal.aborted) {
    await new Promise<void>((done) => io.signal.addEventListener("abort", () => done(), { once: true }));
  }
  stopWatching();
  cancelUsage?.();
  await relay.close();
  log.write({ level: "info", event: "stopped" });
  await log.close();
  return 0;
}
