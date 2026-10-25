import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, onTestFinished } from "vitest";

const run = promisify(execFile);
const script = join(import.meta.dirname, "swift-lint.mjs");

/**
 * Lints Swift files laid out as in `apps/ios`, never failing on the exit code.
 *
 * @sideEffects Makes a temporary folder with the files, removed when the test ends; runs the script.
 * @param files - Each file's path under the folder, and its text.
 * @returns The problems it printed, one per line with the folder cut off, and its exit code.
 */
async function lint(files: Record<string, string>) {
  const dir = await mkdtemp(join(tmpdir(), "atrium-swift-lint-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), text);
  }
  const result = await run(process.execPath, [script, dir]).then(
    ({ stdout }) => ({ stdout, code: 0 }),
    (error: unknown) => ({
      stdout: String(Reflect.get(Object(error), "stdout")),
      code: Number(Reflect.get(Object(error), "code")),
    }),
  );
  const problems = result.stdout
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => line.replaceAll(`${dir}/`, ""));
  return { problems, code: result.code };
}

const documented = [
  "/// Adds one.",
  "///",
  "/// - Remark: Why.",
  "/// - SideEffects: none",
  "/// - Parameter value: The value.",
  "/// - Returns: It plus one.",
].join("\n");

describe("swift-lint.mjs", () => {
  it("passes declarations documented with a summary, a remark and side effects", async () => {
    const result = await lint({
      "AtriumKit/Sources/A/A.swift": [
        "/// A thing.",
        "///",
        "/// - Remark: Why it exists.",
        "@MainActor",
        "public struct Thing: Sendable {",
        "  /// The value; properties need no remark.",
        "  let value: Int",
        documented.replaceAll("\n", "\n  "),
        "  @discardableResult",
        "  func next(_ value: Int) -> Int {",
        '    let text = "func not here"',
        "    return [value].map { $0 + 1 }.first ?? text.count",
        "  }",
        "}",
        "",
        "extension Thing {",
        documented,
        "  static func make(_ value: Int) -> Thing { Thing(value: value) }",
        "}",
      ].join("\n"),
    });

    expect(result).toStrictEqual({ problems: [], code: 0 });
  });

  it("names each declaration without a doc comment, a summary, a remark or side effects", async () => {
    const result = await lint({
      "AtriumKit/Sources/A/A.swift": [
        "struct Bare {}",
        "/// - Remark: No summary.",
        "enum NoSummary {}",
        "/// No remark.",
        "actor NoRemark {}",
        "/// No side effects.",
        "///",
        "/// - Remark: Why.",
        "private func noEffects() {}",
        "/// Init.",
        "///",
        "/// - Remark: Why.",
        "init?() {}",
        "",
        "/// Detached by a blank line.",
        "",
        "final class Detached {}",
      ].join("\n"),
    });

    expect(result.problems).toStrictEqual([
      "AtriumKit/Sources/A/A.swift:1: struct needs a doc comment",
      "AtriumKit/Sources/A/A.swift:3: enum's doc comment needs a summary first",
      "AtriumKit/Sources/A/A.swift:5: actor's doc comment needs - Remark:",
      "AtriumKit/Sources/A/A.swift:9: func's doc comment needs - SideEffects:",
      "AtriumKit/Sources/A/A.swift:13: init's doc comment needs - SideEffects:",
      "AtriumKit/Sources/A/A.swift:17: class needs a doc comment",
    ]);
    expect(result.code).toBe(1);
  });

  it("leaves alone tests, XCTest methods, closures, strings, comments and the generated code", async () => {
    const result = await lint({
      "AtriumKit/Tests/ATests/ATests.swift": [
        "import Testing",
        '@Suite("a") struct ATests {',
        '  @Test("b")',
        "  func b() {}",
        '  @Test("c") func c() {',
        '    let s = """',
        "    func inString() {}",
        '    """',
        "    // func inComment() {}",
        "    /* struct InBlock {} */",
        "    _ = s",
        "  }",
        '  @Test("d", arguments: [',
        '    "x", "y",',
        "  ])",
        "  func d(_ value: String) {}",
        "}",
      ].join("\n"),
      "AtriumUITests/UITests.swift": [
        "import XCTest",
        "/// UI tests.",
        "///",
        "/// - Remark: Why.",
        "final class UITests: XCTestCase {",
        "  func testShowsHome() {}",
        "}",
      ].join("\n"),
      "AtriumKit/Sources/AtriumProtocol/Generated/Protocol.swift": "public struct Generated {}\n",
    });

    expect(result).toStrictEqual({ problems: [], code: 0 });
  });

  it("asks a reason for unchecked concurrency and for a task nobody keeps", async () => {
    const result = await lint({
      "AtriumKit/Sources/A/A.swift": [
        "extension A: @unchecked Sendable {}",
        "// Unchecked: guarded by a lock.",
        "extension B: @unchecked Sendable {}",
        "nonisolated(unsafe) var c = 0",
        "@preconcurrency import Network",
        "let kept = Task { await work() }",
        "_ = Task { await work() }",
        "// Fire and forget: the result is logged inside.",
        "Task.detached { await work() }",
        "Task { await work() }",
      ].join("\n"),
    });

    expect(result.problems).toStrictEqual([
      "AtriumKit/Sources/A/A.swift:1: @unchecked Sendable needs // Unchecked: <why> on the line above",
      "AtriumKit/Sources/A/A.swift:4: nonisolated(unsafe) needs // Unchecked: <why> on the line above",
      "AtriumKit/Sources/A/A.swift:5: @preconcurrency needs // Unchecked: <why> on the line above",
      "AtriumKit/Sources/A/A.swift:7: keep the Task to cancel it, or write // Fire and forget: <why> above",
      "AtriumKit/Sources/A/A.swift:10: keep the Task to cancel it, or write // Fire and forget: <why> above",
    ]);
  });

  it("refuses real time in AtriumKit's sources, but not in the app or the tests", async () => {
    const realTime = [
      "let a = Date()",
      "try await Task.sleep(for: .seconds(1))",
      "Timer.publish(every: 1)",
      "DispatchQueue.main.asyncAfter(deadline: .now()) {}",
    ].join("\n");
    const result = await lint({
      "AtriumKit/Sources/A/A.swift": `${realTime}\nlet b = Date(timeIntervalSince1970: 0)\n`,
      "AtriumKit/Tests/ATests/ATests.swift": realTime,
      "Atrium/AtriumApp.swift": realTime,
    });

    expect(result.problems).toStrictEqual([
      "AtriumKit/Sources/A/A.swift:1: Date() reads real time; take an injected now (coding-standards, Swift)",
      "AtriumKit/Sources/A/A.swift:2: Task.sleep waits on real time; take an injected Clock (coding-standards, Swift)",
      "AtriumKit/Sources/A/A.swift:3: Timer waits on real time; take an injected Clock (coding-standards, Swift)",
      "AtriumKit/Sources/A/A.swift:4: asyncAfter waits on real time; take an injected Clock (coding-standards, Swift)",
    ]);
  });
});
