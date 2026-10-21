import type { Json } from "@atrium/testkit";

/**
 * Maps encoded edit commands to readable JSON and back around fixture normalization.
 * @remarks Random entry ids inside base64url would otherwise evade the shared normalizer;
 * decoded ids retain its existing reference numbering without teaching testkit host commands.
 * @sideEffects none
 * @param normalize - The scenario's existing stateful normalizer.
 * @returns A normalizer that also recognizes id-only edit commands.
 */
export function editNormalizer(normalize: (value: Json) => Json): (value: Json) => Json {
  return (value) => mapCommands(normalize(mapCommands(value, false)), true);
}

/**
 * Walks a fixture value, expanding or re-encoding the hidden command's argument.
 * @remarks Only this command has base64url tree ids; other strings are preserved verbatim.
 * @sideEffects none
 * @param value - A JSON value.
 * @param encode - Whether to put normalized JSON back into base64url.
 * @returns The transformed value.
 */
function mapCommands(value: Json, encode: boolean): Json {
  const prefix = "/atrium-edit ";
  if (typeof value === "string" && value.startsWith(prefix)) {
    const argument = value.slice(prefix.length);
    return (
      prefix +
      (encode ? Buffer.from(argument).toString("base64url") : Buffer.from(argument, "base64url").toString("utf8"))
    );
  }
  if (Array.isArray(value)) return value.map((item) => mapCommands(item, encode));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mapCommands(item, encode)]));
  }
  return value;
}
