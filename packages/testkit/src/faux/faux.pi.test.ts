import { tmpdir } from "node:os";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { once } from "node:events";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type TempDir, createTempDir } from "../temp-dir";
import { FAUX_MODEL, FAUX_PROVIDER, type FauxScript, fauxPi } from "./script";

/** One JSON line pi printed. */
type PiRecord = { readonly type: string } & Readonly<Record<string, unknown>>;

/** A pi RPC process driven by the faux model, with everything it printed so far. */
interface RunningPi {
  /** The temporary directory pi runs in, which is also its HOME. */
  readonly dir: string;
  readonly records: PiRecord[];
  /** Lets a reply scripted with `waitFor` continue. */
  release(name: string): Promise<void>;
  send(command: object): void;
  /** Waits until pi has printed a record matching `predicate`. */
  until(predicate: (record: PiRecord) => boolean): Promise<void>;
}

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

/** Starts `pi --mode rpc` in a fresh temporary HOME, answering from `script`. */
async function startPi(script: FauxScript): Promise<RunningPi> {
  const dir: TempDir = await createTempDir("faux");
  const launch = await fauxPi(script, dir.path);
  const child: ChildProcessWithoutNullStreams = spawn("pi", ["--mode", "rpc", "--no-session", ...launch.args], {
    cwd: dir.path,
    env: { PATH: process.env["PATH"] ?? "", HOME: dir.path, TMPDIR: tmpdir(), ...launch.env },
  });
  const exited = once(child, "exit");
  cleanups.push(async () => {
    child.stdin.end();
    const killer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    await exited;
    clearTimeout(killer);
    await dir.cleanup();
  });

  const records: PiRecord[] = [];
  let pending = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    pending += chunk;
    for (let end = pending.indexOf("\n"); end !== -1; end = pending.indexOf("\n")) {
      records.push(JSON.parse(pending.slice(0, end)) as PiRecord);
      pending = pending.slice(end + 1);
    }
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));

  return {
    dir: dir.path,
    records,
    release: (name) => launch.release(name),
    send: (command) => child.stdin.write(`${JSON.stringify(command)}\n`),
    until: (predicate) =>
      vi.waitFor(
        () => {
          if (!records.some(predicate))
            throw new Error(`pi has not printed the expected record yet; stderr: ${stderr}`);
        },
        { timeout: 20_000, interval: 10 },
      ),
  };
}

/** The `assistantMessageEvent` deltas of one kind, in order. */
function deltas(records: readonly PiRecord[], kind: "text_delta" | "thinking_delta"): string[] {
  return records.flatMap((record) => {
    const event = record["assistantMessageEvent"] as { type: string; delta?: string } | undefined;
    return event?.type === kind && event.delta !== undefined ? [event.delta] : [];
  });
}

/** The last assistant message pi finished. */
function lastAssistant(records: readonly PiRecord[]): Readonly<Record<string, unknown>> {
  const ends = records.filter(
    (record) => record.type === "message_end" && (record["message"] as { role: string }).role === "assistant",
  );
  return ends.at(-1)?.["message"] as Readonly<Record<string, unknown>>;
}

const settled = (record: PiRecord): boolean => record.type === "agent_settled";

/** Runs one prompt to the end and returns what pi printed, with timestamps and the directory blanked. */
async function normalizedRun(script: FauxScript): Promise<string> {
  const pi = await startPi(script);
  pi.send({ id: "r1", type: "prompt", message: "go" });
  await pi.until(settled);
  const json = JSON.stringify(pi.records, (key, value: unknown) => (key === "timestamp" ? 0 : value));
  return json.replaceAll(pi.dir, "<dir>");
}

describe("faux model in a real pi process", () => {
  it("streams scripted thinking and text in several chunks and then settles", async () => {
    const pi = await startPi({
      replies: [
        {
          blocks: [
            { type: "thinking", text: "Plan the answer." },
            { type: "text", text: "Hello from faux." },
          ],
        },
      ],
    });

    pi.send({ id: "r1", type: "prompt", message: "hi" });
    await pi.until(settled);

    expect(deltas(pi.records, "text_delta").length).toBeGreaterThan(1);
    expect(deltas(pi.records, "thinking_delta").join("")).toBe("Plan the answer.");
    expect(deltas(pi.records, "text_delta").join("")).toBe("Hello from faux.");
    expect(lastAssistant(pi.records)).toMatchObject({
      provider: FAUX_PROVIDER,
      model: FAUX_MODEL,
      stopReason: "stop",
      content: [
        { type: "thinking", thinking: "Plan the answer." },
        { type: "text", text: "Hello from faux." },
      ],
    });
    expect(pi.records.map((record) => record.type).slice(-2)).toStrictEqual(["agent_end", "agent_settled"]);
  });

  it("lets pi really run a scripted tool call and feeds the result into the next reply", async () => {
    const pi = await startPi({
      replies: [
        {
          blocks: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "printf 'faux-%s' 42" } }],
        },
        { blocks: [{ type: "text", text: "done" }] },
      ],
    });

    pi.send({ id: "r1", type: "prompt", message: "run it" });
    await pi.until(settled);

    const toolTurn = pi.records.find((record) => record.type === "turn_end");
    expect(toolTurn).toMatchObject({ message: { stopReason: "toolUse" } });
    const toolEnd = pi.records.find((record) => record.type === "tool_execution_end");
    expect(toolEnd).toMatchObject({
      toolCallId: "call-1",
      toolName: "bash",
      result: { content: [{ type: "text", text: "faux-42" }] },
    });
    expect(lastAssistant(pi.records)).toMatchObject({ stopReason: "stop", content: [{ type: "text", text: "done" }] });
  });

  it("ends a reply scripted as an error with stopReason error and its message", async () => {
    const pi = await startPi({ replies: [{ blocks: [], error: "scripted failure" }] });

    pi.send({ id: "r1", type: "prompt", message: "go" });
    await pi.until(settled);

    expect(lastAssistant(pi.records)).toMatchObject({ stopReason: "error", errorMessage: "scripted failure" });
  });

  it("can be interrupted mid-stream when paced with tokensPerSecond", async () => {
    const text = "A slow reply that is long enough to still be streaming when the abort arrives.";
    const pi = await startPi({ tokensPerSecond: 20, replies: [{ blocks: [{ type: "text", text }] }] });

    pi.send({ id: "r1", type: "prompt", message: "go" });
    await pi.until(
      (record) => (record["assistantMessageEvent"] as { type?: string } | undefined)?.type === "text_delta",
    );
    pi.send({ id: "r2", type: "abort" });
    await pi.until(settled);

    expect(lastAssistant(pi.records)).toMatchObject({ stopReason: "aborted" });
    expect(deltas(pi.records, "text_delta").join("").length).toBeLessThan(text.length);
  });

  it("keeps pi's agent directory inside the test directory instead of HOME", async () => {
    const pi = await startPi({ replies: [{ blocks: [{ type: "text", text: "ok" }] }] });

    pi.send({ id: "r1", type: "prompt", message: "go" });
    await pi.until(settled);

    expect((await readdir(join(pi.dir, "pi-agent"))).toSorted()).toStrictEqual(["auth.json", "models-store.json"]);
    expect(await readdir(pi.dir)).not.toContain(".pi");
  });

  it("prints the same records on every run apart from timestamps and the working directory", async () => {
    const script: FauxScript = {
      replies: [
        {
          blocks: [
            { type: "thinking", text: "Check first." },
            { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "echo same" } },
          ],
        },
        { blocks: [{ type: "text", text: "Same every time." }] },
      ],
    };
    const first = await normalizedRun(script);
    const second = await normalizedRun(script);

    expect(second).toBe(first);
  });

  it("holds a reply until its gate is released, printing nothing for the reply meanwhile", async () => {
    const pi = await startPi({ replies: [{ waitFor: "go", blocks: [{ type: "text", text: "after the gate" }] }] });

    pi.send({ id: "r1", type: "prompt", message: "go" });
    await pi.until((record) => record.type === "turn_start");
    await new Promise((resolve) => setTimeout(resolve, 300));
    const whileHeld = pi.records.filter((record) => record.type === "message_update").length;
    await pi.release("go");
    await pi.until(settled);

    expect(whileHeld).toBe(0);
    expect(deltas(pi.records, "text_delta").join("")).toBe("after the gate");
  });

  it("ends a held reply when the run is aborted", async () => {
    const pi = await startPi({ replies: [{ waitFor: "never", blocks: [{ type: "text", text: "unseen" }] }] });

    pi.send({ id: "r1", type: "prompt", message: "go" });
    await pi.until((record) => record.type === "turn_start");
    pi.send({ id: "r2", type: "abort" });
    await pi.until(settled);

    expect(lastAssistant(pi.records)).toMatchObject({ stopReason: "aborted" });
  });

  it("answers handled for /faux-noop without starting a run", async () => {
    const pi = await startPi({ replies: [] });

    pi.send({ id: "r1", type: "prompt", message: "/faux-noop" });
    await pi.until((record) => record.type === "response");

    expect(pi.records).toStrictEqual([
      { id: "r1", type: "response", command: "prompt", success: true, data: { disposition: "handled" } },
    ]);
  });

  it("asks the client through /faux-confirm and reports the answer", async () => {
    const pi = await startPi({ replies: [] });

    pi.send({ id: "r1", type: "prompt", message: "/faux-confirm" });
    await pi.until((record) => record.type === "extension_ui_request");
    const request = pi.records.find((record) => record.type === "extension_ui_request");
    pi.send({ type: "extension_ui_response", id: request?.["id"], confirmed: true });
    await pi.until((record) => record["method"] === "notify");

    expect(request).toMatchObject({ method: "confirm", title: "Proceed?", message: "The faux extension asks." });
    expect(pi.records.find((record) => record["method"] === "notify")).toMatchObject({
      type: "extension_ui_request",
      message: "confirmed",
      notifyType: "info",
    });
  });
});
