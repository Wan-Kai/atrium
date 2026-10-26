import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Checks the Swift rules swift-format and the compiler cannot: doc comments on every declaration,
 * a reason for unchecked concurrency and for tasks nobody keeps, and no real time in AtriumKit.
 *
 * `node scripts/swift-lint.mjs <dir>` prints `file:line: problem` lines and exits 1 when there are
 * any (coding-standards.md "Swift（手机端）"). It reads lines, not a syntax tree: comments and string
 * contents are blanked out first, and only declarations at the start of a line count, so odd
 * layouts may slip through rather than be reported wrongly. Generated code is skipped.
 */

/** A declaration that needs a doc comment, with any attributes and modifiers before it. */
const DECLARATION =
  /^\s*(?:@[A-Za-z_]\w*(?:\([^)]*\))?\s+)*(?:(?:public|private|fileprivate|internal|open|package|static|final|override|mutating|nonmutating|nonisolated|indirect|convenience|required|distributed|dynamic|class(?=\s+(?:func|subscript)\b))(?:\([^)]*\))?\s+)*(struct|class|enum|actor|protocol|func|init|subscript)\b/u;

/** Text holding only attributes, as above a declaration; arguments may nest parentheses. */
const ATTRIBUTES = /^\s*(?:@[A-Za-z_]\w*(?:\(.*\))?\s*)+$/u;

/**
 * The comments that exempt the line below from a rule; they sit between a declaration and its doc
 * comment, since each must be right above the line it exempts.
 */
const EXEMPTION = /^\/\/ (?:Unchecked|Fire and forget):/u;

/** Declarations that run code, so they must say their side effects. */
const RUNS_CODE = new Set(["func", "init", "subscript"]);

/** Concurrency escapes that need `// Unchecked: <why>` on the line above. */
const UNCHECKED = [
  ["@unchecked Sendable", /@unchecked\s+Sendable\b/u],
  ["nonisolated(unsafe)", /\bnonisolated\(unsafe\)/u],
  ["@preconcurrency", /@preconcurrency\b/u],
];

/** An unstructured task, and what comes before it on the line. */
const TASK = /^(.*?)\bTask(?:\.detached)?\s*(?:\([^)]*\))?\s*\{/u;

/** Ways of reading or waiting on real time, refused in AtriumKit's sources. */
const REAL_TIME = [
  [/\bDate\(\)/u, "Date() reads real time; take an injected now (coding-standards, Swift)"],
  [/\bTask\.sleep\b/u, "Task.sleep waits on real time; take an injected Clock (coding-standards, Swift)"],
  [/\bTimer[.(]/u, "Timer waits on real time; take an injected Clock (coding-standards, Swift)"],
  [/\.asyncAfter\(/u, "asyncAfter waits on real time; take an injected Clock (coding-standards, Swift)"],
];

/** Folders never read: build output, Xcode's own, and the generated protocol types. */
const SKIPPED = new Set([".build", ".swiftpm", "Generated", "Atrium.xcodeproj", "xcuserdata"]);

/**
 * Lists the Swift files under a folder.
 *
 * @remarks
 * See `SKIPPED`.
 *
 * @sideEffects Reads directories.
 * @param {string} dir - The folder.
 * @returns {string[]} The files' paths, sorted.
 */
function swiftFiles(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      if (SKIPPED.has(entry.name)) return [];
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return swiftFiles(path);
      return entry.name.endsWith(".swift") ? [path] : [];
    })
    .toSorted();
}

/**
 * Replaces every character but line breaks with a space.
 *
 * @remarks
 * Keeps line numbers and columns of what follows.
 *
 * @sideEffects none
 * @param {string} text - The text.
 * @returns {string} Spaces and line breaks.
 */
function blank(text) {
  return text.replaceAll(/[^\n]/gu, " ");
}

/**
 * Replaces comments and string contents with spaces, keeping line breaks and quotes.
 *
 * @remarks
 * So `"func"` in a string or `// struct` in a comment is not read as code. Handles nested block
 * comments, multi-line strings and raw strings (`#"…"#`).
 *
 * @sideEffects none
 * @param {string} text - Swift source.
 * @returns {string} The same text with only code left.
 */
function codeOnly(text) {
  let out = "";
  let index = 0;
  while (index < text.length) {
    const rest = text.slice(index);
    if (rest.startsWith("//")) {
      const end = text.indexOf("\n", index);
      const stop = end === -1 ? text.length : end;
      out += " ".repeat(stop - index);
      index = stop;
    } else if (rest.startsWith("/*")) {
      let depth = 0;
      let at = index;
      do {
        if (text.startsWith("/*", at)) {
          depth += 1;
          at += 2;
        } else if (text.startsWith("*/", at)) {
          depth -= 1;
          at += 2;
        } else {
          at += 1;
        }
      } while (depth > 0 && at < text.length);
      out += blank(text.slice(index, at));
      index = at;
    } else if (/^#*"/u.test(rest)) {
      const hashes = /^#*/u.exec(rest)?.[0] ?? "";
      const multi = rest.startsWith(`${hashes}"""`);
      const open = `${hashes}${multi ? '"""' : '"'}`;
      const close = `${multi ? '"""' : '"'}${hashes}`;
      let at = index + open.length;
      while (at < text.length && !text.startsWith(close, at)) at += hashes === "" && text[at] === "\\" ? 2 : 1;
      const end = Math.min(at + close.length, text.length);
      out += `${open}${blank(text.slice(index + open.length, at))}${text.slice(at, end)}`;
      index = end;
    } else {
      out += text[index];
      index += 1;
    }
  }
  return out;
}

/**
 * Finds where the attribute ending on a line starts, if the line ends one.
 *
 * @remarks
 * An attribute may span lines (`@Test("…", arguments: [` … `])`); its first line starts with `@`
 * and its parentheses balance by its last line.
 *
 * @sideEffects none
 * @param {string[]} code - The lines with comments and strings blanked.
 * @param {number} end - The line that may end an attribute.
 * @returns {number | null} The attribute's first line, or `null` when `end` ends none.
 */
function attributeStart(code, end) {
  let depth = 0;
  for (let at = end; at >= 0; at -= 1) {
    const line = code[at] ?? "";
    depth += (line.match(/\)/gu) ?? []).length - (line.match(/\(/gu) ?? []).length;
    if (depth > 0) continue;
    return depth === 0 &&
      ATTRIBUTES.test(
        code
          .slice(at, end + 1)
          .join(" ")
          .replaceAll(/\s+/gu, " "),
      )
      ? at
      : null;
  }
  return null;
}

/**
 * Checks the doc comment above one declaration.
 *
 * @remarks
 * The comment must sit right above the declaration, with only attributes and exemption comments
 * (`EXEMPTION`) in between; the
 * summary comes first, then `- Remark:`, and `- SideEffects:` for code that runs.
 *
 * @sideEffects none
 * @param {string[]} raw - The file's lines as written.
 * @param {string[]} code - The same lines with comments and strings blanked.
 * @param {number} index - The declaration's line.
 * @param {string} kind - `struct`, `func` and so on.
 * @param {boolean} xctest - Whether the file imports XCTest.
 * @returns {string | null} The problem, or `null`.
 */
function docProblem(raw, code, index, kind, xctest) {
  let above = index - 1;
  const attributes = [code[index] ?? ""];
  for (;;) {
    if (EXEMPTION.test((raw[above] ?? "").trim())) {
      above -= 1;
      continue;
    }
    const start = attributeStart(code, above);
    if (start === null) break;
    attributes.push(code.slice(start, above + 1).join("\n"));
    above = start - 1;
  }
  if (attributes.some((line) => /@(?:Test|Suite)\b/u.test(line))) return null;
  if (xctest && kind === "func" && /\bfunc\s+test\w*/u.test(code[index] ?? "")) return null;
  const doc = [];
  while (above >= 0 && (raw[above] ?? "").trim().startsWith("///"))
    doc.unshift((raw[above--] ?? "").trim().slice(3).trim());
  if (doc.length === 0) return `${kind} needs a doc comment`;
  if (doc[0] === "" || doc[0]?.startsWith("- ")) return `${kind}'s doc comment needs a summary first`;
  if (!doc.some((line) => /^-\s*Remark:/u.test(line))) return `${kind}'s doc comment needs - Remark:`;
  if (RUNS_CODE.has(kind) && !doc.some((line) => /^-\s*SideEffects:/u.test(line))) {
    return `${kind}'s doc comment needs - SideEffects:`;
  }
  return null;
}

/**
 * Lists the problems in one file.
 *
 * @remarks
 * See the module comment.
 *
 * @sideEffects Reads the file.
 * @param {string} file - The file's path.
 * @returns {string[]} `file:line: problem` for each.
 */
function fileProblems(file) {
  const text = readFileSync(file, "utf8");
  const raw = text.split("\n");
  const code = codeOnly(text).split("\n");
  const xctest = /^\s*import\s+XCTest\b/mu.test(text);
  const sources = file.includes("/AtriumKit/Sources/");
  const problems = [];
  code.forEach((line, index) => {
    /**
     * Notes a problem on this line.
     *
     * @remarks
     * Same format as compilers, so editors can jump to it.
     *
     * @sideEffects Adds to `problems`.
     * @param {string} message - The problem.
     */
    const report = (message) => problems.push(`${file}:${index + 1}: ${message}`);
    const previous = (raw[index - 1] ?? "").trim();
    const declaration = DECLARATION.exec(line);
    if (declaration?.[1] !== undefined) {
      const problem = docProblem(raw, code, index, declaration[1], xctest);
      if (problem !== null) report(problem);
    }
    for (const [name, pattern] of UNCHECKED) {
      if (pattern.test(line) && !previous.startsWith("// Unchecked:")) {
        report(`${name} needs // Unchecked: <why> on the line above`);
      }
    }
    const task = TASK.exec(line);
    const kept =
      task !== null && /(?:[^=!<>]=|\breturn)\s*$/u.test(task[1] ?? "") && !/\b_\s*=\s*$/u.test(task[1] ?? "");
    if (task !== null && !kept && !previous.startsWith("// Fire and forget:")) {
      report("keep the Task to cancel it, or write // Fire and forget: <why> above");
    }
    if (sources) for (const [pattern, message] of REAL_TIME) if (pattern.test(line)) report(message);
  });
  return problems;
}

const problems = swiftFiles(process.argv[2] ?? ".").flatMap(fileProblems);
for (const problem of problems) console.log(problem);
if (problems.length > 0) process.exitCode = 1;
