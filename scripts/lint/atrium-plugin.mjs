/**
 * Local oxlint plugin with Atrium's own rules.
 *
 * @remarks
 * oxlint loads ESLint-compatible JS plugins (oxlint "JS plugins"); the JSDoc requirement in
 * coding-standards.md ("注释：JSDoc") needs a rule no built-in plugin has.
 */

const REQUIRED_TAGS = ["@remarks", "@sideEffects"];

/**
 * Finds the node a JSDoc block should sit in front of.
 *
 * @remarks
 * Exported declarations carry their comment before `export`, and a function stored in a variable
 * carries it before the whole declaration, so the comment's owner is not always the function.
 *
 * @sideEffects none
 * @param {any} node - A function, class or method node.
 * @returns {any} The node whose leading comment documents `node`, or `null` when exempt.
 */
function documentedNode(node) {
  const parent = node.parent;
  if (node.type === "FunctionDeclaration" || node.type === "ClassDeclaration") {
    return parent?.type === "ExportNamedDeclaration" || parent?.type === "ExportDefaultDeclaration" ? parent : node;
  }
  if (node.type === "MethodDefinition") return node;
  if (
    (node.type === "ArrowFunctionExpression" || node.type === "FunctionExpression") &&
    parent?.type === "VariableDeclarator"
  ) {
    const declaration = parent.parent;
    return declaration?.parent?.type === "ExportNamedDeclaration" ? declaration.parent : declaration;
  }
  return null;
}

/**
 * Lists what a JSDoc block is missing.
 *
 * @remarks
 * Checks only the shape (summary line, `@remarks`, `@sideEffects`); whether the text is right is
 * left to review, as coding-standards.md says.
 *
 * @sideEffects none
 * @param {string} text - The comment body without the delimiters.
 * @returns {string[]} Missing parts, empty when complete.
 */
function missingParts(text) {
  const lines = text
    .split("\n")
    .map((line) => line.replace(/^\s*\*\s?/, "").trim())
    .filter((line) => line.length > 0);
  const missing = [];
  if (lines.length === 0 || lines[0].startsWith("@")) missing.push("a summary sentence");
  for (const tag of REQUIRED_TAGS) if (!text.includes(tag)) missing.push(tag);
  return missing;
}

/** Rule: every function, method, class and component has a complete JSDoc block. */
const requireJsdoc = {
  meta: {
    type: "suggestion",
    docs: { description: "Require JSDoc with a summary, @remarks and @sideEffects" },
    messages: {
      missing: "Missing JSDoc. Write what it does, why (@remarks), and its side effects (@sideEffects).",
      incomplete: "JSDoc is missing {{parts}}.",
    },
    schema: [],
  },
  /**
   * Creates the rule's visitors.
   *
   * @remarks
   * Visits the node kinds coding-standards.md lists; inline anonymous callbacks never reach
   * `documentedNode`'s accepted shapes, which is the documented exemption.
   *
   * @sideEffects Reports problems through `context`.
   * @param {any} context - ESLint rule context.
   * @returns {Record<string, (node: any) => void>} Visitors.
   */
  create(context) {
    /**
     * Reports a node whose JSDoc is missing or incomplete.
     *
     * @remarks
     * Looks at the comment directly before the node's documented owner.
     *
     * @sideEffects Reports through `context`.
     * @param {any} node - Visited node.
     */
    const check = (node) => {
      const target = documentedNode(node);
      if (target === null || target === undefined) return;
      const comment = context.sourceCode.getCommentsBefore(target).at(-1);
      if (comment === undefined || comment.type !== "Block" || !comment.value.startsWith("*")) {
        context.report({ node, messageId: "missing" });
        return;
      }
      const missing = missingParts(comment.value);
      if (missing.length > 0) context.report({ node, messageId: "incomplete", data: { parts: missing.join(", ") } });
    };
    return {
      FunctionDeclaration: check,
      ClassDeclaration: check,
      MethodDefinition: check,
      ArrowFunctionExpression: check,
      FunctionExpression: (node) => {
        if (node.parent?.type !== "MethodDefinition") check(node);
      },
    };
  },
};

/**
 * Functions that change something outside the program, by the module they are imported from.
 *
 * @remarks
 * Only names bound by an import count: `exec` on a regular expression or `rm` on some local helper
 * must not look like the child-process or file-system function of the same name.
 */
const MODULE_EFFECTS = new Map([
  ["child_process", ["spawn", "spawnSync", "execFile", "execFileSync", "exec", "execSync", "fork"]],
  [
    "fs",
    [
      "writeFile",
      "appendFile",
      "rename",
      "rm",
      "rmdir",
      "unlink",
      "mkdir",
      "mkdtemp",
      "copyFile",
      "cp",
      "symlink",
      "link",
      "chmod",
      "truncate",
      "utimes",
      "createWriteStream",
    ].flatMap((name) => [name, `${name}Sync`]),
  ],
  ["http", ["request", "get", "createServer"]],
  ["https", ["request", "get", "createServer"]],
  ["net", ["connect", "createConnection", "createServer"]],
]);

/** Global functions with an effect, called by their plain name. */
const GLOBAL_EFFECTS = new Set(["fetch", "setTimeout", "setInterval", "setImmediate"]);

/** Methods with an effect whatever object they are called on, such as an injected clock's timers. */
const ANY_OBJECT_EFFECTS = new Set(["setTimeout", "setInterval"]);

/** Logger levels; a call on an object named `log` or `…logger` writes a log line. */
const LOG_LEVELS = new Set(["trace", "debug", "info", "warn", "error", "fatal"]);

/**
 * The module name without the `node:` scheme, or `null` when it is not one with effects.
 *
 * @remarks
 * `fs/promises` holds the same writers as `fs`.
 *
 * @sideEffects none
 * @param {string} source - The import's module specifier.
 * @returns {string | null} The key into `MODULE_EFFECTS`.
 */
function effectModule(source) {
  const name = source.replace(/^node:/, "").replace(/\/promises$/, "");
  return MODULE_EFFECTS.has(name) ? name : null;
}

/**
 * The last name of an expression such as `logger`, `this.logger` or `deps.log`.
 *
 * @remarks
 * Loggers reach functions under many paths; the final property is what names them.
 *
 * @sideEffects none
 * @param {any} node - An expression.
 * @returns {string | null} The name, or `null` for anything else.
 */
function lastName(node) {
  if (node.type === "Identifier") return node.name;
  if (node.type === "MemberExpression" && !node.computed && node.property.type === "Identifier") {
    return node.property.name;
  }
  return null;
}

/**
 * Whether a JSDoc block declares the function free of side effects.
 *
 * @remarks
 * Only a bare `none` counts; "none until `run`; then …" already says what happens and is left to
 * review.
 *
 * @sideEffects none
 * @param {string} text - The comment body without the delimiters.
 * @returns {boolean} Whether `@sideEffects` is exactly `none`.
 */
function declaresNone(text) {
  const match = /@sideEffects\s+([^\n@]*)/.exec(text);
  return match !== null && /^none\.?$/.test(match[1].replace(/\s*\*?\s*$/, "").trim());
}

/**
 * Whether an expression is the number literal 0.
 *
 * @remarks
 * `process.kill(pid, 0)` checks for a process without signalling it.
 *
 * @sideEffects none
 * @param {any} node - An argument, possibly missing.
 * @returns {boolean} Whether it is `0`.
 */
function isZero(node) {
  return node?.type === "Literal" && node.value === 0;
}

/**
 * The nearest function around a node.
 *
 * @remarks
 * Covers declarations, expressions and arrows alike.
 *
 * @sideEffects none
 * @param {any} node - Any node.
 * @returns {any} The function, or `null` at the top level.
 */
function enclosingFunction(node) {
  let current = node.parent;
  while (current !== null && current !== undefined && !/Function/.test(current.type)) current = current.parent;
  return current ?? null;
}

/**
 * Whether a function is passed straight to a call, as with `new Promise((resolve) => …)`.
 *
 * @remarks
 * Such a callback has no JSDoc of its own (the documented exemption), so what it calls counts
 * towards the function that passes it.
 *
 * @sideEffects none
 * @param {any} fn - A function node.
 * @returns {boolean} Whether it is a call's argument.
 */
function isCallbackArgument(fn) {
  const parent = fn.parent;
  return (parent?.type === "CallExpression" || parent?.type === "NewExpression") && parent.arguments.includes(fn);
}

/** Rule: a function documented `@sideEffects none` does not call an API with a side effect itself. */
const sideEffectsNone = {
  meta: {
    type: "problem",
    docs: { description: "Disallow side-effecting calls in functions documented `@sideEffects none`" },
    messages: {
      contradiction: "`@sideEffects none`, but the function calls `{{call}}`. Describe the side effect.",
    },
    schema: [],
  },
  /**
   * Creates the rule's visitors.
   *
   * @remarks
   * Collects the imported names first, then checks each call against the function it belongs to: the
   * nearest enclosing one, passing through callbacks handed straight to a call (`new Promise(…)`,
   * `.map(…)`, `.then(…)`), whose effects are the caller's. A closure that is returned or stored
   * runs later and is not counted, so the rule errs towards missing a contradiction rather than
   * reporting a false one.
   *
   * @sideEffects Reports problems through `context`.
   * @param {any} context - ESLint rule context.
   * @returns {Record<string, (node: any) => void>} Visitors.
   */
  create(context) {
    /** @type {Map<string, string>} Local name → imported effectful function. */
    const imported = new Map();
    /** @type {Map<string, string>} Local name → effectful module imported whole. */
    const namespaces = new Map();

    /**
     * Names the effect a call or `new` expression has, if any.
     *
     * @remarks
     * See the constants above for what counts.
     *
     * @sideEffects none
     * @param {any} node - A call or `new` expression.
     * @returns {string | null} The call as written, or `null` without an effect.
     */
    const effectOf = (node) => {
      const callee = node.callee;
      if (node.type === "NewExpression") {
        return callee.type === "Identifier" && callee.name === "WebSocket" ? "new WebSocket" : null;
      }
      if (callee.type === "Identifier") {
        if (imported.has(callee.name)) return callee.name;
        return GLOBAL_EFFECTS.has(callee.name) ? callee.name : null;
      }
      if (callee.type !== "MemberExpression" || callee.computed || callee.property.type !== "Identifier") return null;
      const method = callee.property.name;
      const owner = lastName(callee.object);
      const module = callee.object.type === "Identifier" ? namespaces.get(callee.object.name) : undefined;
      if (module !== undefined && MODULE_EFFECTS.get(module)?.includes(method)) return `${owner}.${method}`;
      if (ANY_OBJECT_EFFECTS.has(method)) return `${owner ?? "…"}.${method}`;
      if (owner === "process" && method === "exit") return "process.exit";
      // Signal 0 only asks whether the process exists.
      if (owner === "process" && method === "kill" && !isZero(node.arguments[1])) return "process.kill";
      if (owner === "console") return `console.${method}`;
      if (owner !== null && /^(log|.*logger)$/i.test(owner) && LOG_LEVELS.has(method)) return `${owner}.${method}`;
      return null;
    };

    /**
     * Reports a call with an effect made directly in a function documented `@sideEffects none`.
     *
     * @remarks
     * Stops at the first enclosing function: see `create`.
     *
     * @sideEffects Reports through `context`.
     * @param {any} node - A call or `new` expression.
     */
    const check = (node) => {
      const call = effectOf(node);
      if (call === null) return;
      let fn = enclosingFunction(node);
      while (fn !== null && isCallbackArgument(fn)) fn = enclosingFunction(fn.parent);
      if (fn === null) return;
      const owner = fn.parent?.type === "MethodDefinition" ? fn.parent : fn;
      const target = documentedNode(owner);
      if (target === null || target === undefined) return;
      const comment = context.sourceCode.getCommentsBefore(target).at(-1);
      if (comment === undefined || comment.type !== "Block" || !declaresNone(comment.value)) return;
      context.report({ node, messageId: "contradiction", data: { call } });
    };

    return {
      ImportDeclaration(node) {
        const module = effectModule(String(node.source.value));
        if (module === null) return;
        for (const specifier of node.specifiers) {
          if (specifier.type === "ImportSpecifier") {
            const name = specifier.imported.name ?? specifier.imported.value;
            if (MODULE_EFFECTS.get(module)?.includes(name)) imported.set(specifier.local.name, name);
          } else {
            namespaces.set(specifier.local.name, module);
          }
        }
      },
      CallExpression: check,
      NewExpression: check,
    };
  },
};

export default {
  meta: { name: "atrium" },
  rules: { "require-jsdoc": requireJsdoc, "side-effects-none": sideEffectsNone },
};
