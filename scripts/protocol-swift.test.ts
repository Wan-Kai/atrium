import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, onTestFinished } from "vitest";

const run = promisify(execFile);
const script = join(import.meta.dirname, "protocol-swift.mjs");
const committed = join(
  import.meta.dirname,
  "..",
  "apps",
  "ios",
  "AtriumKit",
  "Sources",
  "AtriumProtocol",
  "Generated",
  "Protocol.swift",
);

/**
 * Runs `protocol-swift.mjs --check`, optionally against another output file, never failing on its exit code.
 *
 * @sideEffects Runs the script, which reads the protocol and the file.
 * @param output - The file to compare with, instead of the committed one.
 * @returns What it printed and its exit code.
 */
async function check(output?: string) {
  const env = output === undefined ? process.env : { ...process.env, ATRIUM_PROTOCOL_SWIFT_OUT: output };
  return run(process.execPath, [script, "--check"], { env }).then(
    ({ stdout }) => ({ stdout, code: 0 }),
    (error: unknown) => ({
      stdout: String(Reflect.get(Object(error), "stdout")),
      code: Number(Reflect.get(Object(error), "code")),
    }),
  );
}

/**
 * A temporary folder, removed when the test ends.
 *
 * @sideEffects Makes the folder.
 * @returns Its path.
 */
async function folder() {
  const dir = await mkdtemp(join(tmpdir(), "atrium-protocol-swift-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

describe("protocol-swift.mjs --check", () => {
  it("passes when the committed Swift types are what packages/protocol generates", async () => {
    expect(await check()).toStrictEqual({ stdout: "", code: 0 });
  });

  it("fails, saying what to run, when the Swift types differ from the protocol by one line", async () => {
    const output = join(await folder(), "Protocol.swift");
    const text = await readFile(committed, "utf8");
    await writeFile(output, text.replace("public let protocolVersion = ", "public let protocolVersion = 1 + "));

    const result = await check(output);

    expect(result.code).toBe(1);
    expect(result.stdout).toContain("is out of date with packages/protocol; run pnpm protocol:swift");
  });

  it("fails when the Swift types are missing", async () => {
    const result = await check(join(await folder(), "Protocol.swift"));

    expect(result.code).toBe(1);
  });
});
