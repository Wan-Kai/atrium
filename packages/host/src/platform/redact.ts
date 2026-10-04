/** Placeholder written instead of a secret. */
const REDACTED = "[redacted]";

/** Turns an arbitrary value into a copy that is safe to log. */
export type Redactor = (value: unknown) => unknown;

const SENSITIVE_KEY =
  /^(token|access_?token|refresh_?token|id_?token|auth_?token|session_?token|bearer|secret|client_?secret|private_?key|password|passwd|api[-_]?key|x-api-key|authorization|proxy-authorization|cookie|set-cookie|credentials?)$/i;
const MAX_DEPTH = 12;
const MIN_SECRET_LENGTH = 8;

/**
 * Creates a function that copies a value for logging with secrets removed.
 *
 * @remarks
 * Two independent defenses (security.md, "凭据与日志"): values under credential-like keys are
 * replaced at any depth, and any string containing a known secret value, such as the session
 * token, has that value replaced wherever it appears. The second catches secrets that end up
 * under an innocent key, for example inside an error message.
 *
 * @sideEffects Calls `secrets` on every use so newly known secrets are covered.
 * @param secrets - Returns the secret values currently in use; values shorter than 8 characters
 * are ignored to avoid erasing ordinary text.
 * @returns The redacting function.
 */
export function createRedactor(secrets: () => Iterable<string>): Redactor {
  return (value) => {
    const known = [...secrets()].filter((secret) => secret.length >= MIN_SECRET_LENGTH);
    return redactValue(value, known, new WeakSet(), 0);
  };
}

/**
 * Recursively copies one value, redacting as it goes.
 *
 * @remarks
 * Errors are flattened to plain objects because their message and stack are not enumerable and
 * would otherwise escape the walk.
 *
 * @sideEffects Adds visited objects to `seen` to break cycles.
 * @param value - Value to copy.
 * @param secrets - Secret values to scrub from strings.
 * @param seen - Objects already on the current path.
 * @param depth - Current nesting depth.
 * @returns The redacted copy.
 */
function redactValue(value: unknown, secrets: readonly string[], seen: WeakSet<object>, depth: number): unknown {
  if (typeof value === "string") return scrub(value, secrets);
  if (typeof value !== "object" || value === null) return value;
  if (depth >= MAX_DEPTH) return "[truncated]";
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => redactValue(item, secrets, seen, depth + 1));
    const entries: Array<[string, unknown]> = Object.entries(value);
    if (value instanceof Error) entries.push(["name", value.name], ["message", value.message], ["stack", value.stack]);
    const copy: Record<string, unknown> = {};
    for (const [key, item] of entries) {
      copy[scrub(key, secrets)] = SENSITIVE_KEY.test(key) ? REDACTED : redactValue(item, secrets, seen, depth + 1);
    }
    return copy;
  } finally {
    seen.delete(value);
  }
}

/**
 * Replaces every occurrence of each secret in a string.
 *
 * @remarks
 * Uses `split`/`join` rather than a regular expression so secrets containing regex
 * metacharacters are matched literally. Repeats until no occurrence is left, because a
 * replacement can join surrounding text into a new occurrence; if that keeps happening, the whole
 * string is dropped rather than risk writing the secret.
 *
 * @sideEffects none
 * @param text - String to scrub.
 * @param secrets - Secret values to remove.
 * @returns The scrubbed string.
 */
function scrub(text: string, secrets: readonly string[]): string {
  let result = text;
  for (const secret of secrets) {
    for (let pass = 0; result.includes(secret); pass++) {
      if (pass === 4) return REDACTED;
      result = result.split(secret).join(REDACTED);
    }
  }
  return result;
}
