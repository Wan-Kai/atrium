/**
 * `pnpm boundary`: lists the external boundaries a change touches, or checks all production code.
 *
 * @remarks
 * Review should not depend on someone spotting in the code which dependencies, environment
 * variables, URLs, hidden commands or protocol version a change touches. This script lists them
 * from the code and marks what security.md ("外部边界登记") does not list. What counts as
 * production code and how each kind is recognised is written there. Plain `node` with oxc-parser:
 * TypeScript 7 has no JS compiler API to parse with (development.md, "环境与版本").
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { parseSync } from "oxc-parser";

const REGISTRY = "docs/architecture/security.md";
const PROTOCOL_VERSION_FILE = "packages/protocol/src/version.ts";
const OXLINT = join(import.meta.dirname, "..", "node_modules", ".bin", "oxlint");

/** The three kinds the registry lists, by the heading of their table in security.md. */
const KINDS = [
  { key: "urls", heading: "出网地址", label: "URLs", one: "URL" },
  { key: "env", heading: "环境变量", label: "environment variables", one: "environment variable" },
  { key: "commands", heading: "隐藏命令", label: "hidden commands", one: "hidden command" },
];

const DEPENDENCY_SECTIONS = ["dependencies", "optionalDependencies", "peerDependencies", "devDependencies"];
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const URL_PATTERN = /\b(?:https?|wss?):\/\/[^\s"'`<>()[\]{}|\\^]+/g;
const CONSTANT_CASE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;
const CONSTANT_PREFIX = /^[A-Z][A-Z0-9]*_$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Node's error codes (`ERR_STREAM_PREMATURE_CLOSE`) are spelled like variables but compared with `error.code`. */
const ERROR_CODE = /^ERR_/;
/** Marks a registry row whose address is put together at run time, so code never holds it whole. */
const COMPOSED = "（拼出）";
const PLACEHOLDER = "\u0000";

/**
 * Whether a repository path is production code.
 *
 * @remarks
 * The scope security.md gives: the packages' and the desktop app's `src`, without tests, benches,
 * test helpers and pi contract scenarios.
 *
 * @sideEffects none
 * @param {string} path - A path relative to the repository root.
 * @returns {boolean} Whether it is scanned.
 */
function isProduction(path) {
  return (
    /^(?:packages\/(?:protocol|pi|host|client|ui)|apps\/desktop)\/src\/.*\.(?:ts|tsx|mts|cts|mjs|cjs|js)$/.test(path) &&
    !/\.(?:test|bench)\.[^/]+$/.test(path) &&
    !/\/test\//.test(path) &&
    !path.startsWith("packages/pi/src/contract/")
  );
}

/**
 * Runs git in the repository.
 *
 * @remarks
 * Synchronous: this is a short command-line script (coding-standards.md lets `scripts/` be plain).
 *
 * @sideEffects Runs git.
 * @param {string} root - The repository root.
 * @param {string[]} args - git's arguments.
 * @param {string} [input] - Its standard input.
 * @returns {Buffer} Its output.
 */
function git(root, args, input) {
  return execFileSync("git", args, { cwd: root, input, maxBuffer: 256 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] });
}

/**
 * Splits git's NUL-separated output into paths.
 *
 * @remarks
 * `-z` keeps paths with odd characters intact.
 *
 * @sideEffects none
 * @param {Buffer} output - git's output.
 * @returns {string[]} The paths.
 */
function paths(output) {
  return output
    .toString("utf8")
    .split("\0")
    .filter((path) => path !== "");
}

/**
 * Reads files of the working tree: tracked and untracked, as the review template's scope has it.
 *
 * @remarks
 * Deleted but still tracked files are left out.
 *
 * @sideEffects Runs git; reads files.
 * @param {string} root - The repository root.
 * @param {(path: string) => boolean} keep - Which paths to read.
 * @returns {Map<string, string>} Contents by path.
 */
function workingFiles(root, keep) {
  const listed = paths(git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]));
  const files = new Map();
  for (const path of new Set(listed)) {
    if (keep(path) && existsSync(join(root, path))) files.set(path, readFileSync(join(root, path), "utf8"));
  }
  return files;
}

/**
 * Reads files of a commit in one `git cat-file --batch`.
 *
 * @remarks
 * One git process for the whole tree instead of one per file.
 *
 * @sideEffects Runs git.
 * @param {string} root - The repository root.
 * @param {string} commit - The commit.
 * @param {(path: string) => boolean} keep - Which paths to read.
 * @returns {Map<string, string>} Contents by path.
 */
function commitFiles(root, commit, keep) {
  const wanted = paths(git(root, ["ls-tree", "-r", "-z", "--name-only", commit])).filter(keep);
  const files = new Map();
  if (wanted.length === 0) return files;
  const output = git(root, ["cat-file", "--batch"], wanted.map((path) => `${commit}:${path}\n`).join(""));
  let offset = 0;
  for (const path of wanted) {
    const headerEnd = output.indexOf(10, offset);
    const size = Number(output.subarray(offset, headerEnd).toString("utf8").split(" ")[2]);
    files.set(path, output.subarray(headerEnd + 1, headerEnd + 1 + size).toString("utf8"));
    offset = headerEnd + 1 + size + 1;
  }
  return files;
}

/**
 * Whether a name is an environment object's.
 *
 * @remarks
 * `env`, `environment`, or ending in `Env` such as `toolEnv`, as the code names them.
 *
 * @sideEffects none
 * @param {string} name - An identifier or property name.
 * @returns {boolean} Whether it names an environment.
 */
function envName(name) {
  return /^(?:env|environment)$|Env$/.test(name);
}

/**
 * Whether an expression is an environment object such as `process.env`, `options.env` or `toolEnv`.
 *
 * @remarks
 * Named by convention across the code; `import.meta.env` is Vite's build constants, not the process
 * environment.
 *
 * @sideEffects none
 * @param {any} node - An expression.
 * @returns {boolean} Whether its last name is `env`, `environment` or ends in `Env`.
 */
function isEnvObject(node) {
  if (node.type === "Identifier") return envName(node.name);
  if (node.type === "MemberExpression" && !node.computed && node.object.type !== "MetaProperty") {
    return envName(node.property.name);
  }
  return false;
}

/**
 * The name of a property key that is written out, or `null` for a computed one.
 *
 * @remarks
 * Both `PATH: …` and `"PATH": …` name the variable.
 *
 * @sideEffects none
 * @param {any} property - An object property or pattern property.
 * @returns {string | null} The name.
 */
function keyName(property) {
  if (property.type !== "Property" || property.computed) return null;
  if (property.key.type === "Identifier") return property.key.name;
  return typeof property.key.value === "string" ? property.key.value : null;
}

/**
 * Whether an object literal holds environment variables.
 *
 * @remarks
 * It spreads an environment (`{ ...env, PATH }`), is an `env:` option, or is stored under an
 * environment's name.
 *
 * @sideEffects none
 * @param {any} node - An object expression.
 * @returns {boolean} Whether its keys are variable names.
 */
function isEnvLiteral(node) {
  if (node.properties.some((property) => property.type === "SpreadElement" && isEnvObject(property.argument))) {
    return true;
  }
  const parent = node.parent;
  if (parent?.type === "Property" && parent.value === node && keyName(parent) === "env") return true;
  return parent?.type === "VariableDeclarator" && parent.id.type === "Identifier" && isEnvObject(parent.id);
}

/**
 * Resolves a relative import to a scanned file.
 *
 * @remarks
 * TypeScript imports leave the extension out.
 *
 * @sideEffects none
 * @param {string} from - The importing file.
 * @param {string} specifier - The import's module specifier.
 * @param {Map<string, unknown>} files - The scanned files.
 * @returns {string | null} The imported file.
 */
function resolveImport(from, specifier, files) {
  if (!specifier.startsWith(".")) return null;
  const base = posix.join(posix.dirname(from), specifier);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}.mjs`, `${base}.js`, `${base}/index.ts`]) {
    if (files.has(candidate)) return candidate;
  }
  return null;
}

/**
 * Finds the URLs, environment variables and hidden commands in production files.
 *
 * @remarks
 * Works on the syntax tree, so comments and regular expressions never count; the rules are in
 * security.md ("外部边界登记"). A hidden command named by a constant is looked up in the same file or
 * in a relatively imported one.
 *
 * @sideEffects none
 * @param {Map<string, string>} files - Contents by path.
 * @returns {Record<string, Map<string, string[]>>} Each kind's items, with where they appear.
 * @throws {Error} When a file does not parse.
 */
function scan(files) {
  const found = { urls: new Map(), env: new Map(), commands: new Map() };
  const constants = new Map();
  const imports = new Map();
  const pending = [];

  for (const [path, text] of files) {
    const parsed = parseSync(path, text);
    if (parsed.errors.length > 0) throw new Error(`cannot parse ${path}: ${parsed.errors[0].message}`);
    const lineStarts = [0];
    for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1))
      lineStarts.push(index + 1);
    const fileConstants = new Map();
    const fileImports = new Map();
    constants.set(path, fileConstants);
    imports.set(path, fileImports);

    /**
     * Records an item at a node.
     *
     * @remarks
     * Locations are `path:line`, the line found by binary search over line starts.
     *
     * @sideEffects Adds to `found`.
     * @param {string} kind - The kind.
     * @param {string} item - The item.
     * @param {any} node - Where it is.
     */
    const add = (kind, item, node) => {
      let low = 0;
      let high = lineStarts.length - 1;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (lineStarts[middle] <= node.start) low = middle;
        else high = middle - 1;
      }
      const places = found[kind].get(item) ?? [];
      const place = `${path}:${low + 1}`;
      if (!places.includes(place)) places.push(place);
      found[kind].set(item, places);
    };

    /**
     * Records the URLs in a piece of text, `${…}` written as `*`.
     *
     * @remarks
     * Trailing sentence punctuation is not part of an address.
     *
     * @sideEffects Adds to `found`.
     * @param {string} value - The text, holes marked by the placeholder.
     * @param {any} node - Where it is.
     */
    const addUrls = (value, node) => {
      for (const match of value.matchAll(URL_PATTERN)) {
        add("urls", match[0].replace(/[.,;:!?]+$/, "").replaceAll(PLACEHOLDER, "*"), node);
      }
    };

    /**
     * Records a string that is spelled like an environment variable.
     *
     * @remarks
     * `"ATRIUM_"` is a prefix, written `ATRIUM_*`.
     *
     * @sideEffects Adds to `found`.
     * @param {string} value - The string.
     * @param {any} node - Where it is.
     */
    const addConstant = (value, node) => {
      if (ERROR_CODE.test(value)) return;
      if (CONSTANT_CASE.test(value)) add("env", value, node);
      else if (CONSTANT_PREFIX.test(value)) add("env", `${value}*`, node);
    };

    /**
     * Visits a node and its children, linking each to its parent.
     *
     * @remarks
     * oxc-parser's tree has no parent links; some rules look one level up.
     *
     * @sideEffects Adds to `found`, `constants`, `imports` and `pending`; sets `parent` on nodes.
     * @param {any} node - The node.
     * @param {any} parent - Its parent.
     */
    const visit = (node, parent) => {
      node.parent = parent;
      switch (node.type) {
        case "Literal":
          if (typeof node.value === "string" && parent?.type !== "ImportDeclaration") {
            addUrls(node.value, node);
            addConstant(node.value, node);
          }
          break;
        case "TemplateLiteral": {
          const value = node.quasis.map((quasi) => quasi.value.cooked ?? quasi.value.raw).join(PLACEHOLDER);
          addUrls(value, node);
          if (node.expressions.length === 0) addConstant(value, node);
          break;
        }
        case "JSXText":
          addUrls(node.value, node);
          break;
        case "MemberExpression":
          if (isEnvObject(node.object)) {
            const name = node.computed ? node.property.value : node.property.name;
            if (typeof name === "string" && ENV_NAME.test(name)) add("env", name, node.property);
          }
          break;
        case "VariableDeclarator":
          if (node.id.type === "ObjectPattern" && node.init !== null && isEnvObject(node.init)) {
            for (const property of node.id.properties) {
              const name = keyName(property);
              if (name !== null) add("env", name, property);
            }
          }
          if (
            (parent?.parent?.type === "Program" || parent?.parent?.parent?.type === "Program") &&
            node.id.type === "Identifier" &&
            node.init?.type === "Literal" &&
            typeof node.init.value === "string"
          ) {
            fileConstants.set(node.id.name, node.init.value);
          }
          break;
        case "ObjectExpression":
          if (isEnvLiteral(node)) {
            for (const property of node.properties) {
              const name = keyName(property);
              if (name !== null && ENV_NAME.test(name)) add("env", name, property);
            }
          }
          break;
        case "ArrayExpression": {
          const names = node.elements.map((element) =>
            element?.type === "Literal" && typeof element.value === "string" ? element.value : null,
          );
          if (
            names.length > 0 &&
            names.every((name) => name !== null && /^[A-Z_][A-Z0-9_]*$/.test(name)) &&
            names.some((name) => name.includes("_"))
          ) {
            node.elements.forEach((element, index) => {
              if (!CONSTANT_CASE.test(names[index]) && !ERROR_CODE.test(names[index]))
                add("env", names[index], element);
            });
          }
          break;
        }
        case "ImportDeclaration":
          for (const specifier of node.specifiers) {
            if (specifier.type === "ImportSpecifier") {
              fileImports.set(specifier.local.name, {
                source: node.source.value,
                name: specifier.imported.name ?? specifier.imported.value,
              });
            }
          }
          break;
        case "CallExpression": {
          const callee = node.callee;
          const name = callee.type === "MemberExpression" && !callee.computed ? callee.property.name : callee.name;
          const argument = node.arguments[0];
          if (name === "registerCommand" && argument !== undefined) {
            if (argument.type === "Literal" && typeof argument.value === "string") {
              add("commands", `/${argument.value}`, argument);
            } else if (argument.type === "Identifier") {
              pending.push({ path, name: argument.name, add, node: argument });
            }
          }
          break;
        }
      }
      for (const key of Object.keys(node)) {
        if (key === "parent") continue;
        const child = node[key];
        if (Array.isArray(child)) {
          for (const item of child) if (item !== null && typeof item?.type === "string") visit(item, node);
        } else if (child !== null && typeof child?.type === "string") {
          visit(child, node);
        }
      }
    };
    visit(parsed.program, null);
  }

  for (const { path, name, add, node } of pending) {
    const imported = imports.get(path).get(name);
    const file = imported === undefined ? path : resolveImport(path, imported.source, files);
    const value = file === null ? undefined : constants.get(file)?.get(imported?.name ?? name);
    add("commands", value === undefined ? `/?${name}` : `/${value}`, node);
  }
  return found;
}

/**
 * Reads the registry tables from security.md.
 *
 * @remarks
 * Only the "外部边界登记" section counts; each table's rows are listed by the first backticked text
 * in their first cell, compared exactly. Rows marked `（拼出）` in that cell are left out: their address
 * is built from a login's `baseUrl` at run time, so no code matches them and they are never stale.
 *
 * @sideEffects none
 * @param {string} text - security.md.
 * @returns {Record<string, Set<string>>} Each kind's registered items.
 * @throws {Error} When the section is missing.
 */
function readRegistry(text) {
  const section = /^## 外部边界登记\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(text);
  if (section === null) throw new Error(`${REGISTRY} has no "## 外部边界登记" section`);
  const registry = { urls: new Set(), env: new Set(), commands: new Set() };
  let kind = null;
  for (const line of section[1].split("\n")) {
    const heading = /^### (.+)$/.exec(line);
    if (heading !== null) kind = KINDS.find((one) => one.heading === heading[1].trim())?.key ?? null;
    const row = /^\|\s*`([^`]+)`([^|]*)/.exec(line);
    if (kind !== null && row !== null && !row[2].includes(COMPOSED)) registry[kind].add(row[1]);
  }
  return registry;
}

/**
 * Lists every dependency in a set of package.json files.
 *
 * @remarks
 * Keyed by file, section and name so two versions can be compared entry by entry.
 *
 * @sideEffects none
 * @param {Map<string, string>} files - package.json contents by path.
 * @returns {Map<string, { file: string, section: string, name: string, version: string }>} The entries.
 */
function dependencies(files) {
  const entries = new Map();
  for (const [file, text] of files) {
    const manifest = JSON.parse(text);
    for (const section of DEPENDENCY_SECTIONS) {
      for (const [name, version] of Object.entries(manifest[section] ?? {})) {
        entries.set(`${file}\0${DEPENDENCY_SECTIONS.indexOf(section)}\0${name}`, { file, section, name, version });
      }
    }
  }
  return entries;
}

/**
 * Whether a dependency's version is pinned.
 *
 * @remarks
 * coding-standards.md ("依赖") locks exact versions; `workspace:` links are the repository's own.
 *
 * @sideEffects none
 * @param {string} version - The version as written.
 * @returns {boolean} Whether it is exact.
 */
function isExact(version) {
  return EXACT_VERSION.test(version) || version.startsWith("workspace:");
}

/**
 * Whether a path is a package manifest of the repository.
 *
 * @remarks
 * Installed packages' manifests are ignored by git anyway; this keeps them out of `ls-tree` too.
 *
 * @sideEffects none
 * @param {string} path - A repository path.
 * @returns {boolean} Whether it is one.
 */
function isManifest(path) {
  return /(?:^|\/)package\.json$/.test(path) && !path.includes("node_modules/");
}

/**
 * The `PROTOCOL_VERSION` a version file declares.
 *
 * @remarks
 * Read as text: the file is a single constant.
 *
 * @sideEffects none
 * @param {string | undefined} text - The file, if it exists.
 * @returns {string | null} The version.
 */
function protocolVersion(text) {
  return /PROTOCOL_VERSION\s*=\s*(\d+)/.exec(text ?? "")?.[1] ?? null;
}

/**
 * Runs the `atrium/side-effects-none` rule on changed files.
 *
 * @remarks
 * The rule is part of `pnpm check`; listing its findings here puts them next to the boundaries in
 * the review report. Uses the repository's own oxlint configuration.
 *
 * @sideEffects Runs oxlint.
 * @param {string} root - The repository root.
 * @param {string[]} changed - Changed paths.
 * @returns {string[] | null} The findings, or `null` without a configuration.
 */
function sideEffectContradictions(root, changed) {
  if (!existsSync(join(root, ".oxlintrc.json"))) return null;
  const files = changed.filter((path) => /\.(?:ts|tsx|mts|cts|mjs|cjs|js)$/.test(path) && existsSync(join(root, path)));
  if (files.length === 0) return [];
  let output;
  try {
    output = execFileSync(OXLINT, ["-c", ".oxlintrc.json", "-f", "unix", ...files], { cwd: root, encoding: "utf8" });
  } catch (error) {
    output = String(Reflect.get(Object(error), "stdout"));
  }
  return output
    .split("\n")
    .filter((line) => line.includes("(side-effects-none)"))
    .map((line) => line.replace(/ \[[^\]]*\(side-effects-none\)\]$/, ""));
}

/**
 * Checks all production code against the registry and prints what is missing.
 *
 * @remarks
 * Part of `pnpm check`, so it prints one line when all is well.
 *
 * @sideEffects Runs git; reads files; prints.
 * @param {string} root - The repository root.
 * @param {Record<string, Set<string>>} registry - The registered items.
 * @returns {number} The exit code.
 */
function checkAll(root, registry) {
  const found = scan(workingFiles(root, isProduction));
  const lines = [];
  let unregistered = 0;
  for (const kind of KINDS) {
    const missing = [...found[kind.key].keys()].filter((item) => !registry[kind.key].has(item)).toSorted();
    unregistered += missing.length;
    if (missing.length > 0) lines.push(`Unregistered ${kind.label}:`);
    for (const item of missing) lines.push(`  ${item}  ${where(found[kind.key].get(item))}`);
  }
  const loose = [...dependencies(workingFiles(root, isManifest)).entries()]
    .toSorted(([a], [b]) => (a < b ? -1 : 1))
    .map(([, entry]) => entry)
    .filter((entry) => !isExact(entry.version));
  if (loose.length > 0) lines.push("Dependencies without an exact version:");
  for (const entry of loose) lines.push(`  ${entry.file} ${entry.section}: ${entry.name} ${entry.version}`);
  const stale = KINDS.flatMap((kind) =>
    [...registry[kind.key]].filter((item) => !found[kind.key].has(item)).map((item) => `  ${kind.one} ${item}`),
  );
  if (stale.length > 0) lines.push("Registered but not found in production code:", ...stale);
  const counts = KINDS.map((kind) => `${kind.label} ${found[kind.key].size}`).join(", ");
  lines.push(`boundary --all: ${counts}; unregistered ${unregistered}, not exact ${loose.length}`);
  console.log(lines.join("\n"));
  return unregistered > 0 || loose.length > 0 ? 1 : 0;
}

/**
 * Where an item appears: the first place and how many more.
 *
 * @remarks
 * One location is enough to find it; the count says it is not alone.
 *
 * @sideEffects none
 * @param {string[]} places - `path:line` entries.
 * @returns {string} The description.
 */
function where(places) {
  return places.length > 1 ? `${places[0]} (+${places.length - 1} more)` : places[0];
}

/**
 * Lists the boundaries changed since a base commit and prints them.
 *
 * @remarks
 * The scope is the review template's (acceptance.md): commits since the base, uncommitted changes
 * and untracked files. Items are compared as sets over all production code, so moving one between
 * files is no change.
 *
 * @sideEffects Runs git and oxlint; reads files; prints.
 * @param {string} root - The repository root.
 * @param {Record<string, Set<string>>} registry - The registered items.
 * @param {string} base - The base commit.
 * @param {string} label - How the base is described.
 * @returns {number} The exit code.
 */
function checkChanges(root, registry, base, label) {
  const lines = [`Boundary changes since ${label}`, ""];
  let unregistered = 0;
  let loose = 0;

  lines.push("Dependencies:");
  const before = dependencies(commitFiles(root, base, isManifest));
  const after = dependencies(workingFiles(root, isManifest));
  const dependencyLines = [];
  for (const key of [...new Set([...before.keys(), ...after.keys()])].toSorted()) {
    const old = before.get(key);
    const now = after.get(key);
    const entry = now ?? old;
    const head = `${entry.file} ${entry.section}: ${entry.name}`;
    const flag = now !== undefined && !isExact(now.version) ? "  NOT EXACT" : "";
    if (old === undefined) dependencyLines.push(`  + ${head} ${now.version}${flag}`);
    else if (now === undefined) dependencyLines.push(`  - ${head} ${old.version}`);
    else if (old.version !== now.version) dependencyLines.push(`  ~ ${head} ${old.version} -> ${now.version}${flag}`);
    else continue;
    if (flag !== "") loose += 1;
  }
  lines.push(...(dependencyLines.length > 0 ? dependencyLines : ["  (none)"]));

  const was = scan(commitFiles(root, base, isProduction));
  const is = scan(workingFiles(root, isProduction));
  for (const kind of KINDS) {
    lines.push(`${kind.label[0].toUpperCase()}${kind.label.slice(1)}:`);
    const itemLines = [];
    for (const item of [...is[kind.key].keys()].filter((one) => !was[kind.key].has(one)).toSorted()) {
      const registered = registry[kind.key].has(item);
      if (!registered) unregistered += 1;
      itemLines.push(`  + ${item}  ${where(is[kind.key].get(item))}  ${registered ? "registered" : "UNREGISTERED"}`);
    }
    for (const item of [...was[kind.key].keys()].filter((one) => !is[kind.key].has(one)).toSorted()) {
      itemLines.push(`  - ${item}${registry[kind.key].has(item) ? "  still registered" : ""}`);
    }
    lines.push(...(itemLines.length > 0 ? itemLines : ["  (none)"]));
  }

  const changed = [
    ...new Set([
      ...paths(git(root, ["diff", "--name-only", "-z", base])),
      ...paths(git(root, ["ls-files", "-z", "--others", "--exclude-standard"])),
    ]),
  ].toSorted();
  const oldVersion = protocolVersion(
    commitFiles(root, base, (path) => path === PROTOCOL_VERSION_FILE).get(PROTOCOL_VERSION_FILE),
  );
  const newVersion = protocolVersion(
    existsSync(join(root, PROTOCOL_VERSION_FILE)) ? readFileSync(join(root, PROTOCOL_VERSION_FILE), "utf8") : undefined,
  );
  if (oldVersion === newVersion) {
    lines.push(`Protocol version: ${newVersion ?? "not found"} (unchanged)`);
    const protocolChanged = changed.some(
      (path) => path.startsWith("packages/protocol/src/") && !/\.(?:test|bench)\.[^/]+$/.test(path),
    );
    if (protocolChanged) lines.push("  WARNING: packages/protocol/src changed but PROTOCOL_VERSION did not");
  } else {
    lines.push(`Protocol version: ${oldVersion ?? "none"} -> ${newVersion ?? "none"}`);
  }

  lines.push("@sideEffects contradictions in changed files:");
  const contradictions = sideEffectContradictions(root, changed);
  if (contradictions === null) lines.push("  (not checked: no .oxlintrc.json)");
  else lines.push(...(contradictions.length > 0 ? contradictions.map((line) => `  ${line}`) : ["  (none)"]));

  lines.push(`Result: unregistered ${unregistered}, not exact ${loose}`);
  console.log(lines.join("\n"));
  return unregistered > 0 || loose > 0 ? 1 : 0;
}

/**
 * Runs the command: `--all`, or the changes since a base (default: the merge-base with `main`).
 *
 * @remarks
 * Exit codes: 0 clean, 1 something unregistered or not exact, 2 a usage or repository error.
 *
 * @sideEffects Runs git and oxlint; reads files; prints; sets the exit code.
 * @param {string[]} args - The command-line arguments.
 */
function main(args) {
  try {
    const root = git(process.cwd(), ["rev-parse", "--show-toplevel"]).toString("utf8").trim();
    const registry = readRegistry(readFileSync(join(root, REGISTRY), "utf8"));
    if (args[0] === "--all") {
      process.exitCode = checkAll(root, registry);
      return;
    }
    const explicit = args[0];
    let base;
    try {
      base = git(
        root,
        explicit === undefined
          ? ["merge-base", "HEAD", "main"]
          : ["rev-parse", "--verify", "-q", `${explicit}^{commit}`],
      )
        .toString("utf8")
        .trim();
    } catch {
      throw new Error(explicit === undefined ? "no merge-base of HEAD and main" : `not a commit: ${explicit}`);
    }
    const short = base.slice(0, 7);
    process.exitCode = checkChanges(
      root,
      registry,
      base,
      explicit === undefined ? `${short} (merge-base of HEAD and main)` : `${explicit} (${short})`,
    );
  } catch (error) {
    console.error(`boundary: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}

main(process.argv.slice(2));
