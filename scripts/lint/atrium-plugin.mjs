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

export default { meta: { name: "atrium" }, rules: { "require-jsdoc": requireJsdoc } };
