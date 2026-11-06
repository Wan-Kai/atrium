import { CommandError, type SteerCommand, type VisualChangedEvent, type VisualSource } from "@atrium/protocol";
import { FakeClock, createTempDir } from "@atrium/testkit";
import { chmod, mkdir, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { recordingTracing } from "../../test/recording-tracing";
import { VISUAL_CSP } from "./shell";
import { type WatchFolder, createVisualService } from "./visual-service";

const TRACEPARENT = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

/**
 * A visual service over real files, with a fake clock and a watcher the test fires.
 *
 * @remarks
 * Sessions `s1` and `s2` each have a working directory with its visuals inside, as a study
 * direction has; `s3` is a child of `s1`, `s4` a child of `s3`, each with its own; anything else
 * is unknown.
 *
 * @sideEffects Creates temporary directories, removed when the test ends.
 * @returns The service and what it did.
 */
async function harness(failAtOnce = false) {
  const temp = await createTempDir("visual-service");
  onTestFinished(temp.cleanup);
  const root = await realpath(temp.path);
  const cwd = join(root, "s1");
  const dir = join(cwd, "visuals");
  await mkdir(dir, { recursive: true });
  for (const other of ["s2", "s3", "s4"]) await mkdir(join(root, other, "visuals"), { recursive: true });
  const clock = new FakeClock(1_000);
  const { logger, records, resources } = recordingTracing();
  const sent: [string, VisualChangedEvent][] = [];
  const steered: [SteerCommand, VisualSource][] = [];
  const folders = new Map<string, { readonly fire: () => void; readonly fail: () => void }>();
  const stopped: string[] = [];
  const watch: WatchFolder = (folder, onEvent, onError) => {
    folders.set(folder, { fire: onEvent, fail: onError });
    if (failAtOnce) onError();
    return () => {
      folders.delete(folder);
      stopped.push(folder);
    };
  };
  let tokens = 0;
  const service = createVisualService({
    locate: (sessionId) => {
      const ancestors = { s1: [], s2: [], s3: ["s1"], s4: ["s3", "s1"] }[sessionId];
      return ancestors === undefined
        ? undefined
        : {
            cwd: join(root, sessionId),
            dir: join(root, sessionId, "visuals"),
            ancestors: ancestors.map((up) => join(root, up, "visuals")),
          };
    },
    steer: async (command, source) => {
      steered.push([command, source]);
      return { disposition: "started" };
    },
    send: (connectionId, event) => sent.push([connectionId, event]),
    clock,
    resources,
    logger,
    watch,
    newToken: () => String(++tokens).padStart(32, "0"),
  });
  onTestFinished(() => service.close());
  return { service, root, cwd, dir, clock, records, resources, sent, steered, folders, stopped };
}

/**
 * The error code a call fails with.
 *
 * @remarks
 * Every refusal is a `CommandError`.
 *
 * @sideEffects none
 * @param call - The failing call.
 * @returns The code.
 */
async function refusal(call: Promise<unknown>): Promise<string> {
  try {
    await call;
  } catch (error) {
    if (error instanceof CommandError) return error.code;
    throw error;
  }
  throw new Error("the call passed");
}

/**
 * Serves the service's HTTP handler on a local port for the test.
 *
 * @remarks
 * The real `node:http` server, as the host's own.
 *
 * @sideEffects Listens on 127.0.0.1, closed when the test ends.
 * @param handle - The handler.
 * @returns The base address.
 */
async function serving(handle: (request: IncomingMessage, response: ServerResponse) => Promise<void>): Promise<string> {
  const server: Server = createServer((request, response) => void handle(request, response));
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  onTestFinished(() => new Promise<void>((done) => server.close(() => done())));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/**
 * How many folder watches the service holds, 0 when it never held one.
 *
 * @remarks
 * A kind never acquired is not in the snapshot at all.
 *
 * @sideEffects none
 * @param resources - The tracker.
 * @returns The count.
 */
function watchesOf(resources: { snapshot(): Record<string, number> }): number {
  return resources.snapshot()["visual.watch"] ?? 0;
}

describe("resolving a visual", () => {
  it("hands out one sandbox address per file, with its size and time, and watches its folder", async () => {
    const { service, dir, folders } = await harness();
    await writeFile(join(dir, "2-03 isolation.html"), "<p>x</p>");

    const first = await service.resolve("c1", "s1", "visuals/2-03 isolation.html");
    const again = await service.resolve("c2", "s1", join(dir, "2-03 isolation.html"));

    expect(first).toStrictEqual({
      url: `atrium-visual://${"1".padStart(32, "0")}/2-03%20isolation.html`,
      size: 8,
      mtime: first.mtime,
    });
    expect(again.url).toBe(first.url);
    expect([...folders.keys()]).toStrictEqual([dir]);
  });

  it("refuses an unknown session and a file the checks refuse, watching only for a missing one to appear", async () => {
    const { service, cwd, dir, folders } = await harness();
    await writeFile(join(cwd, "outside.html"), "x");

    expect(await refusal(service.resolve("c1", "nobody", "visuals/a.html"))).toBe("session_not_found");
    expect(await refusal(service.resolve("c1", "s1", "outside.html"))).toBe("visual_outside");
    expect(await refusal(service.resolve("c1", "s2", join(cwd, "visuals", "a.html")))).toBe("visual_outside");
    expect(folders.size).toBe(0);
    expect(await refusal(service.resolve("c1", "s1", "visuals/none.html"))).toBe("visual_missing");
    expect([...folders.keys()]).toStrictEqual([dir]);
  });

  it("opens a visual of a session's parent, or its parent's parent, for a fork or child, never an unrelated one", async () => {
    const { service, root } = await harness();
    await writeFile(join(root, "s1", "visuals", "a.html"), "x");
    await writeFile(join(root, "s3", "visuals", "b.html"), "x");

    const fromChild = await service.resolve("c1", "s3", join(root, "s1", "visuals", "a.html"));
    const fromGrandchild = await service.resolve("c1", "s4", join(root, "s1", "visuals", "a.html"));
    const ownOfParent = await service.resolve("c1", "s4", join(root, "s3", "visuals", "b.html"));

    expect([fromChild.size, fromGrandchild.size, ownOfParent.size]).toStrictEqual([1, 1, 1]);
    expect(await refusal(service.resolve("c1", "s1", join(root, "s3", "visuals", "b.html")))).toBe("visual_outside");
    expect(await refusal(service.resolve("c1", "s2", join(root, "s1", "visuals", "a.html")))).toBe("visual_outside");
  });

  it("adds no watch for a resolve that ends after its connection closed, or the service did", async () => {
    const { service, dir, folders, resources } = await harness();
    await writeFile(join(dir, "a.html"), "x");

    const resolving = service.resolve("c1", "s1", "visuals/a.html");
    service.disconnect("c1");
    await resolving;
    expect(folders.size).toBe(0);
    const later = service.resolve("c2", "s1", "visuals/a.html");
    service.close();
    await later;

    expect(folders.size).toBe(0);
    expect(watchesOf(resources)).toBe(0);
  });

  it("forgets a file's address once no connection looks at it, and gives a new one when asked again", async () => {
    const { service, dir } = await harness();
    await writeFile(join(dir, "a.html"), "x");
    const base = await serving((request, response) => service.serve(request, response));
    const { url } = await service.resolve("c1", "s1", "visuals/a.html");
    const kept = await service.resolve("c2", "s1", "visuals/a.html");
    service.disconnect("c1");
    expect(kept.url).toBe(url);
    expect((await fetch(`${base}/visual/${new URL(url).host}/a.html`)).status).toBe(200);

    service.disconnect("c2");

    expect((await fetch(`${base}/visual/${new URL(url).host}/a.html`)).status).toBe(404);
    expect((await service.resolve("c3", "s1", "visuals/a.html")).url).not.toBe(url);
  });
});

describe("resolving visuals of their own", () => {
  it("gives each file its own address", async () => {
    const { service, dir } = await harness();
    await writeFile(join(dir, "a.html"), "x");
    await writeFile(join(dir, "b.html"), "x");

    const a = await service.resolve("c1", "s1", "visuals/a.html");
    const b = await service.resolve("c1", "s1", "visuals/b.html");

    expect(new URL(a.url).host).not.toBe(new URL(b.url).host);
  });

  it("stops a watch that failed as it started, and keeps nothing of it", async () => {
    const { service, dir, folders, stopped, resources } = await harness(true);
    await writeFile(join(dir, "a.html"), "x");

    await service.resolve("c1", "s1", "visuals/a.html");

    expect(folders.size).toBe(0);
    expect(stopped).toStrictEqual([dir]);
    expect(resources.snapshot()).toMatchObject({ "visual.watch": 0 });
  });

  it("forgets an unknown connection quietly, and stops every watch when it closes", async () => {
    const { service, dir, folders, resources } = await harness();
    await writeFile(join(dir, "a.html"), "x");
    await service.resolve("c1", "s1", "visuals/a.html");

    service.disconnect("nobody");
    expect(folders.size).toBe(1);
    service.close();

    expect(folders.size).toBe(0);
    expect(resources.snapshot()).toMatchObject({ "visual.watch": 0 });
  });
});

describe("serving a visual", () => {
  it("answers its address with the frame around the file as it is now, and the sandbox's policy", async () => {
    const { service, dir } = await harness();
    await writeFile(join(dir, "a.html"), "<p>one</p>");
    const { url } = await service.resolve("c1", "s1", "visuals/a.html");
    await writeFile(join(dir, "a.html"), "<p>two</p>");
    const base = await serving((request, response) => service.serve(request, response));

    const response = await fetch(`${base}/visual/${new URL(url).host}/a.html?v=1`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("content-security-policy")).toBe(VISUAL_CSP);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(await response.text()).toContain("<body><p>two</p></body>");
  });

  it("answers 404 for a file it may no longer read, with nothing of its path in the logs", async () => {
    const { service, dir, records } = await harness();
    await writeFile(join(dir, "a.html"), "x");
    const { url } = await service.resolve("c1", "s1", "visuals/a.html");
    await chmod(join(dir, "a.html"), 0o000);
    onTestFinished(() => chmod(join(dir, "a.html"), 0o644));
    const base = await serving((request, response) => service.serve(request, response));

    expect((await fetch(`${base}/visual/${new URL(url).host}/a.html`)).status).toBe(404);
    expect(JSON.stringify(records)).not.toContain(dir);
  });

  it("answers 404 for an unknown token, another method, or a file that became unsafe", async () => {
    const { service, dir, cwd } = await harness();
    await writeFile(join(dir, "a.html"), "x");
    const { url } = await service.resolve("c1", "s1", "visuals/a.html");
    const base = await serving((request, response) => service.serve(request, response));
    const token = new URL(url).host;

    expect((await fetch(`${base}/visual/${"f".repeat(32)}/a.html`)).status).toBe(404);
    expect((await fetch(`${base}/visual/${token}/a.html`, { method: "POST" })).status).toBe(404);
    expect((await fetch(`${base}/visual/`)).status).toBe(404);
    await writeFile(join(dir, "a.html"), "a".repeat(1024 * 1024 + 1));
    expect((await fetch(`${base}/visual/${token}/a.html`)).status).toBe(404);
    await writeFile(join(cwd, "b.html"), "x");
    expect((await fetch(`${base}/visual/${token}/../../b.html`)).status).toBe(404);
  });
});

describe("watching visuals", () => {
  it("tells each connection that resolved a file when it changed, once a burst of events is over", async () => {
    const { service, dir, clock, sent, folders } = await harness();
    await writeFile(join(dir, "a.html"), "x");
    await writeFile(join(dir, "b.html"), "x");
    await service.resolve("c1", "s1", "visuals/a.html");
    await service.resolve("c2", "s1", join(dir, "a.html"));
    await service.resolve("c2", "s1", "visuals/b.html");

    await utimes(join(dir, "a.html"), 2_000, 2_000);
    folders.get(dir)?.fire();
    folders.get(dir)?.fire();
    clock.advance(99);
    await service.settled();
    expect(sent).toStrictEqual([]);
    clock.advance(1);
    await service.settled();

    expect(sent).toStrictEqual([
      ["c1", { type: "visual_changed", sessionId: "s1", path: "visuals/a.html", mtime: 2_000_000 }],
      ["c2", { type: "visual_changed", sessionId: "s1", path: join(dir, "a.html"), mtime: 2_000_000 }],
    ]);
    folders.get(dir)?.fire();
    clock.advance(100);
    await service.settled();
    expect(sent).toHaveLength(2);
  });

  it("stops watching a folder once no connection looks at its files, and counts the watch and its timer", async () => {
    const { service, dir, folders, stopped, resources, clock } = await harness();
    await writeFile(join(dir, "a.html"), "x");
    const before = resources.snapshot();
    await service.resolve("c1", "s1", "visuals/a.html");
    await service.resolve("c2", "s1", "visuals/a.html");
    folders.get(dir)?.fire();

    expect(resources.snapshot()).toMatchObject({ "visual.watch": 1, timer: 1 });
    service.disconnect("c1");
    expect(stopped).toStrictEqual([]);
    service.disconnect("c2");

    expect(stopped).toStrictEqual([dir]);
    expect(resources.snapshot()).toStrictEqual({ ...before, "visual.watch": 0, timer: 0 });
    clock.advance(100);
    await service.settled();
    expect(resources.snapshot()).toStrictEqual({ ...before, "visual.watch": 0, timer: 0 });
  });

  it("logs a watch that fails without its folder, and stops it", async () => {
    const { service, dir, folders, stopped, records } = await harness();
    await writeFile(join(dir, "a.html"), "x");
    await service.resolve("c1", "s1", "visuals/a.html");

    folders.get(dir)?.fail();

    expect(stopped).toStrictEqual([dir]);
    expect(records.filter((record) => record["msg"] === "visual watch failed")).toHaveLength(1);
    expect(JSON.stringify(records)).not.toContain(dir);
    await service.resolve("c1", "s1", "visuals/a.html");
    expect([...folders.keys()]).toStrictEqual([dir]);
  });
});

/**
 * A visual's message of session `s1`, its request named by its text.
 *
 * @remarks
 * For the rate limit's cases.
 *
 * @sideEffects none
 * @param path - The visual.
 * @param text - The message.
 * @returns The command's fields.
 */
function message(path: string, text: string) {
  return { requestId: text, traceparent: TRACEPARENT, sessionId: "s1", path, text };
}

describe("watching visuals that come and go", () => {
  it("tells of a watched file deleted, with time 0, and of it written again", async () => {
    const { service, dir, clock, sent, folders } = await harness();
    await writeFile(join(dir, "a.html"), "x");
    await service.resolve("c1", "s1", "visuals/a.html");

    await rm(join(dir, "a.html"));
    folders.get(dir)?.fire();
    clock.advance(100);
    await service.settled();
    await writeFile(join(dir, "a.html"), "y");
    await utimes(join(dir, "a.html"), 3_000, 3_000);
    folders.get(dir)?.fire();
    clock.advance(100);
    await service.settled();

    expect(sent).toStrictEqual([
      ["c1", { type: "visual_changed", sessionId: "s1", path: "visuals/a.html", mtime: 0 }],
      ["c1", { type: "visual_changed", sessionId: "s1", path: "visuals/a.html", mtime: 3_000_000 }],
    ]);
  });

  it("tells of a file missing when resolved once it appears, in a folder made only later", async () => {
    const { service, dir, clock, sent, folders } = await harness();
    expect(await refusal(service.resolve("c1", "s1", "visuals/lesson/a.html"))).toBe("visual_missing");
    expect([...folders.keys()]).toStrictEqual([dir]);

    await mkdir(join(dir, "lesson"));
    folders.get(dir)?.fire();
    clock.advance(100);
    await service.settled();
    expect([...folders.keys()]).toStrictEqual([join(dir, "lesson")]);
    await writeFile(join(dir, "lesson", "a.html"), "x");
    await utimes(join(dir, "lesson", "a.html"), 4_000, 4_000);
    folders.get(join(dir, "lesson"))?.fire();
    clock.advance(100);
    await service.settled();

    expect(sent).toStrictEqual([
      ["c1", { type: "visual_changed", sessionId: "s1", path: "visuals/lesson/a.html", mtime: 4_000_000 }],
    ]);
    await service.resolve("c1", "s1", "visuals/lesson/a.html");
    expect([...folders.keys()]).toStrictEqual([join(dir, "lesson")]);
  });
});

describe("sending from a visual", () => {
  it("sends the text as a steer from the visual, as the session's message", async () => {
    const { service, dir, steered } = await harness();
    await writeFile(join(dir, "a.html"), "x");

    const result = await service.send({
      requestId: "r1",
      traceparent: TRACEPARENT,
      sessionId: "s1",
      path: "visuals/a.html",
      text: "选 B",
    });

    expect(result).toStrictEqual({ disposition: "started" });
    expect(steered).toStrictEqual([
      [
        { type: "steer", requestId: "r1", traceparent: TRACEPARENT, sessionId: "s1", text: "选 B" },
        { kind: "visual", path: "visuals/a.html" },
      ],
    ]);
  });

  it("drops a second message from the same visual within a second, logging only how many", async () => {
    const { service, dir, steered, clock, records } = await harness();
    await writeFile(join(dir, "a.html"), "x");
    await writeFile(join(dir, "b.html"), "x");

    await service.send(message("visuals/a.html", "one"));
    clock.advance(999);
    const dropped = await service.send(message(join(dir, "a.html"), "secret two"));
    const other = await service.send(message("visuals/b.html", "three"));
    clock.advance(1);
    const later = await service.send(message("visuals/a.html", "four"));

    expect([dropped, other, later]).toStrictEqual([
      { disposition: "dropped" },
      { disposition: "started" },
      { disposition: "started" },
    ]);
    expect(steered.map(([command]) => command.text)).toStrictEqual(["one", "three", "four"]);
    expect(records.filter((record) => record["msg"] === "visual message dropped")).toMatchObject([{ dropped: 1 }]);
    expect(JSON.stringify(records)).not.toContain("secret two");
  });

  it("sends one of two messages from the same visual that arrive together", async () => {
    const { service, dir, steered } = await harness();
    await writeFile(join(dir, "a.html"), "x");
    const command = { requestId: "r1", traceparent: TRACEPARENT, sessionId: "s1", path: "visuals/a.html" };

    const answers = await Promise.all([
      service.send({ ...command, text: "选 A" }),
      service.send({ ...command, requestId: "r2", text: "选 B" }),
    ]);

    expect(answers).toStrictEqual([{ disposition: "started" }, { disposition: "dropped" }]);
    expect(steered.map(([sent]) => sent.text)).toStrictEqual(["选 A"]);
  });

  it("refuses a message from a file that is no visual of the session", async () => {
    const { service, cwd, steered } = await harness();
    await writeFile(join(cwd, "a.html"), "x");

    expect(
      await refusal(
        service.send({ requestId: "r1", traceparent: TRACEPARENT, sessionId: "s1", path: "a.html", text: "x" }),
      ),
    ).toBe("visual_outside");
    expect(steered).toStrictEqual([]);
  });
});
