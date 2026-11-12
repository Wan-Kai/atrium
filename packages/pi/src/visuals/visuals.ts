import { encodeArgument } from "../agent/agent";

/** The flag the host gives Atrium's extension the session's directory for visuals in (SPEC-0007). */
export const VISUALS_FLAG = "atrium-visuals";

/** The system prompt section the extension adds; pi wraps it in a tag of this name. */
export const VISUALS_SECTION = "atrium_visuals";

/** What the host tells the extension about visuals. */
export interface VisualsLaunch {
  readonly v: 1;
  /** The absolute directory the agent writes the session's visuals into. */
  readonly dir: string;
  /**
   * `visuals` for a study direction's session: the directory is `visuals/` of its working
   * directory, written and referenced by that relative path, as the direction may move (SPEC-0008, ML4).
   */
  readonly relative?: "visuals";
}

/**
 * The icons a visual's frame offers, by the name a fragment writes in `<i data-icon="…">`.
 *
 * @remarks
 * A common subset of Hugeicons, not all of them (SPEC-0007, "运行环境", 2026-11-05): first those
 * Atrium's own interface draws with, then what demonstrations need — playing, directions, right
 * and wrong, more and less. The host draws each from Hugeicons; the prompt lists the names.
 */
export const VISUAL_ICONS = [
  "play",
  "pause",
  "stop",
  "next",
  "previous",
  "refresh",
  "reset",
  "chevron-left",
  "chevron-right",
  "chevron-up",
  "chevron-down",
  "arrow-left",
  "arrow-right",
  "arrow-up",
  "arrow-down",
  "check",
  "close",
  "check-circle",
  "cancel-circle",
  "plus",
  "minus",
  "info",
  "alert",
  "help",
  "search",
  "settings",
  "clock",
  "database",
  "file",
  "folder",
  "lock",
  "unlock",
  "user",
  "server",
  "computer",
  "cloud",
  "git-branch",
  "git-commit",
  "git-merge",
  "flash",
  "key",
  "eye",
  "code",
  "terminal",
  "sparkles",
  "shuffle",
  "sort",
  "expand",
  "shrink",
  "bug",
  "layers",
  "link",
  "globe",
  "flag",
  "star",
  "heart",
  "delete",
  "copy",
  "cpu",
  "chart-line",
  "chart-bar",
  "pie-chart",
  "grid",
] as const;
export type VisualIcon = (typeof VISUAL_ICONS)[number];

/**
 * The sites a visual may load libraries and fonts from (SPEC-0007, "沙箱", 2026-11-05).
 *
 * @remarks
 * The desktop shell enforces the same list with pinned versions (`main/visual-sandbox.ts`); this
 * copy only tells the model, as the host's CSP repeats it.
 */
export const VISUAL_CDN_HOSTS = [
  "https://cdnjs.cloudflare.com",
  "https://cdn.jsdelivr.net",
  "https://esm.sh",
  "https://unpkg.com",
  "https://fonts.googleapis.com",
  "https://fonts.gstatic.com",
] as const;

/** The colour, font and radius variables the frame sets, following Atrium's light and dark. */
export const VISUAL_VARIABLES = [
  "--surface-1",
  "--surface-2",
  "--surface-3",
  "--code",
  "--text",
  "--text-2",
  "--text-3",
  "--text-muted",
  "--text-dim",
  "--line",
  "--line-soft",
  "--line-strong",
  "--hover",
  "--selected",
  "--tint",
  "--on-tint",
  "--attn",
  "--danger",
  "--ok",
  "--diff-add-bg",
  "--diff-del-bg",
  "--font-sans",
  "--font-mono",
  "--fs",
  "--fs-sm",
  "--fs-xs",
  "--r-sm",
  "--r",
  "--r-md",
] as const;

/**
 * Encodes what the host tells the extension, for `--atrium-visuals`.
 *
 * @remarks
 * Base64url JSON, as `--atrium-agent` is: a path may hold any character.
 *
 * @sideEffects none
 * @param dir - The session's directory for visuals.
 * @param relative - `visuals` for a study direction's session (ML4).
 * @returns The flag's value.
 */
export function visualsArgument(dir: string, relative?: "visuals"): string {
  return encodeArgument({ v: 1, dir, ...(relative === undefined ? {} : { relative }) } satisfies VisualsLaunch);
}

/**
 * Reads `--atrium-visuals`.
 *
 * @remarks
 * Anything but a version 1 object with an absolute directory, and `relative` absent or
 * `visuals`, reads as none: the session then gets no instructions on visuals, as a pi Atrium did
 * not start.
 *
 * @sideEffects none
 * @param flag - The flag's value, as pi gives it.
 * @returns The launch, or `null`.
 */
export function readVisualsArgument(flag: unknown): VisualsLaunch | null {
  if (typeof flag !== "string" || flag === "") return null;
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(flag, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const v: unknown = Reflect.get(value, "v");
  const dir: unknown = Reflect.get(value, "dir");
  const relative: unknown = Reflect.get(value, "relative");
  if (v !== 1 || typeof dir !== "string" || !dir.startsWith("/") || dir.length > 4096) return null;
  if (relative !== undefined && relative !== "visuals") return null;
  return { v: 1, dir, ...(relative === undefined ? {} : { relative }) };
}

/**
 * The system prompt's instructions on visuals, in English as Atrium's other tools are.
 *
 * @remarks
 * SPEC-0007, "怎么让 agent 知道": where the directory is, the fragment's rules, when to make one
 * and how to send an answer back. Rules of a container, such as study mode's, are in its own
 * AGENTS.md, not here. A study direction's session (ML4) writes in `visuals/` of its working
 * directory and references it by that relative path, which still finds it once the direction is
 * archived or restored; its naming rule is in the study prompt.
 *
 * @sideEffects none
 * @param dir - The session's directory for visuals.
 * @param relative - `visuals` for a study direction's session.
 * @returns The section's text.
 */
export function visualsPrompt(dir: string, relative?: "visuals"): string {
  const how =
    relative === undefined
      ? [
          `How: write the fragment to a file in ${dir} (create the directory if needed), with a name ending in .html, then put this code block in your reply where it should appear:`,
          "```visual",
          `{"path":"${dir}/<name>.html","title":"<short title>"}`,
          "```",
        ]
      : [
          `How: write the fragment to a file in the ${relative}/ folder of the working directory (create the folder if needed), with a name ending in .html, then put this code block in your reply where it should appear:`,
          "```visual",
          `{"path":"${relative}/<name>.html","title":"<short title>"}`,
          "```",
          "Always reference it by this relative path, never an absolute one: the folder may move, and the relative path still finds it.",
        ];
  return [
    "You can show the user an interactive visual inline in your reply: a small HTML fragment that Atrium runs in a sandbox at the place you reference it.",
    "",
    'When to make one: only for something with steps, changing state or conditions to compare (two transactions interleaving, a request passing middleware, an algorithm step by step), and only when it clearly explains better than text. Use a Mermaid block for static structure and a Markdown table for tables. Do not mention the implementation in your text (no "I wrote an HTML file"); explain in the reply, keep the fragment to the visual itself.',
    "",
    ...how,
    "To change a visual, edit the same file and reference it again in that reply; every card showing the file reloads.",
    "",
    "Rules for the fragment:",
    "- A fragment only: no <!doctype>, <html>, <head> or <body>. Under 1 MB. Give its root element a unique id.",
    "- No network: fetch, XMLHttpRequest, WebSocket and EventSource are blocked.",
    `- Libraries and fonts load only from ${VISUAL_CDN_HOSTS.join(", ")}, always with the exact full version pinned in the address (d3@7.9.0, /ajax/libs/d3/7.9.0/...); an address without one, or with a range or a tag such as @latest, is blocked. On esm.sh always add ?bundle (d3@7.9.0?bundle), so its dependencies come inlined in one file: without it the modules it serves import their dependencies by version range, and those requests are blocked; on jsDelivr's /gh/ pin a whole commit or a vX.Y.Z tag.`,
    `- Write your own styles. To follow Atrium's light and dark, use these CSS variables: ${VISUAL_VARIABLES.join(", ")}.`,
    `- Icons: <i data-icon="name"></i> with one of ${VISUAL_ICONS.join(", ")}. Do not draw icons or load an icon library.`,
    "- To send the user's answer back, call window.atrium.sendMessage(text) from a click handler; it reaches you as the user's message. It only works right after the user clicks in the visual, at most 4000 characters, once a second.",
    "- The visual cannot read the conversation or files, call tools, or receive your replies.",
  ].join("\n");
}
