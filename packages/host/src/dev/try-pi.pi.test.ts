import { type FauxScript, createTempDir, fauxPi } from "@atrium/testkit";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { runTry } from "./try-pi";

/** Runs `runTry` against real pi answering from `script`, capturing output and log records. */
async function tryWith(script: FauxScript) {
  const dir = await createTempDir("try-pi");
  onTestFinished(dir.cleanup);
  const launch = await fauxPi(script, dir.path);
  const out: string[] = [];
  const err: string[] = [];
  const code = await runTry(
    { prompt: "say hello", cwd: dir.path, inheritEnv: true, keepSession: false, piArgs: launch.args },
    {
      home: join(dir.path, "atrium"),
      env: { PATH: process.env["PATH"], HOME: dir.path, ...launch.env },
      stdout: { write: (text) => out.push(text), color: false },
      stderr: { write: (text) => err.push(text), color: false },
    },
  );
  const log = await readFile(join(dir.path, "atrium", "dev-logs", "current.log"), "utf8");
  const records = log
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  return { code, out: out.join(""), err: err.join(""), records };
}

describe("pnpm pi:try with real pi", () => {
  it("streams the reply through the host and records the run as one trace", async () => {
    const { code, out, err, records } = await tryWith({
      replies: [
        {
          blocks: [
            { type: "thinking", text: "Thinking." },
            { type: "text", text: "Hello through the host." },
          ],
        },
      ],
    });

    expect(code).toBe(0);
    expect(out).toBe("Thinking.\nHello through the host.\n");
    const traceId = /^trace ([0-9a-f]{32})/.exec(err)?.[1];
    const spans = records.filter((record) => record["kind"] === "span");
    expect(spans.map((span) => [span["name"], span["status"], span["trace_id"]])).toStrictEqual([
      ["pi.rpc prompt", "ok", traceId],
      ["pi.process", "ok", traceId],
      ["dev.try-pi", "ok", traceId],
    ]);
  });

  it("exits with 1 when the model reply fails", async () => {
    const { code, err } = await tryWith({ replies: [{ blocks: [], error: "scripted failure" }] });

    expect(code).toBe(1);
    expect(err).toContain("pi: scripted failure");
  });
});
