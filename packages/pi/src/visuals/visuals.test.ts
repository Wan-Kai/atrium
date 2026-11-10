import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, expectTypeOf, it } from "vitest";
import atriumVisuals, { type VisualsApi } from "./extension";
import {
  VISUALS_FLAG,
  VISUALS_SECTION,
  VISUAL_CDN_HOSTS,
  VISUAL_ICONS,
  readVisualsArgument,
  visualsArgument,
  visualsPrompt,
} from "./visuals";

/**
 * Loads the extension into a stand-in for pi with a flag value, and runs its hook once.
 *
 * @remarks
 * Records what it registered, as pi would hold it.
 *
 * @sideEffects none
 * @param flag - What pi gives for `--atrium-visuals`.
 * @returns The sections after the hook, and the flags it registered.
 */
function startRun(flag: string | undefined): { sections: Record<string, string>; flags: unknown[]; events: string[] } {
  const flags: unknown[] = [];
  const events: string[] = [];
  let hook: ((event: { systemPromptOptions: { sections: Record<string, string> } }) => void) | undefined;
  const pi: VisualsApi = {
    registerFlag: (name, options) => flags.push([name, options]),
    getFlag: (name) => (name === VISUALS_FLAG ? flag : undefined),
    on: (event, handler) => {
      events.push(event);
      hook = handler;
    },
  };
  atriumVisuals(pi);
  const sections: Record<string, string> = { cwd: "/repo" };
  hook?.({ systemPromptOptions: { sections } });
  return { sections, flags, events };
}

describe("visuals in the system prompt", () => {
  it("adds one section naming the directory, once pi has set the flag", () => {
    const { sections, flags, events } = startRun(visualsArgument("/Users/me/.atrium/visuals/s1"));

    expectTypeOf<ExtensionAPI>().toExtend<VisualsApi>();
    expect(VISUALS_FLAG).toBe("atrium-visuals");
    expect(VISUALS_SECTION).toBe("atrium_visuals");
    expect(flags).toStrictEqual([
      [VISUALS_FLAG, { description: "Where this session's visuals go, set by Atrium's host", type: "string" }],
    ]);
    expect(events).toStrictEqual(["before_agent_start"]);
    expect(Object.keys(sections)).toStrictEqual(["cwd", VISUALS_SECTION]);
    expect(sections[VISUALS_SECTION]).toBe(visualsPrompt("/Users/me/.atrium/visuals/s1"));
    expect(sections[VISUALS_SECTION]).toContain("in /Users/me/.atrium/visuals/s1 (create");
  });

  it("leaves the prompt alone without the flag, or with one it cannot read", () => {
    for (const flag of [undefined, "", "not base64 json", Buffer.from('{"v":2,"dir":"/a"}').toString("base64url")]) {
      expect(startRun(flag).sections).toStrictEqual({ cwd: "/repo" });
    }
  });

  it("reads back only a version 1 launch with an absolute directory", () => {
    expect(readVisualsArgument(visualsArgument("/a b/ü"))).toStrictEqual({ v: 1, dir: "/a b/ü" });
    for (const value of [{ v: 1, dir: "relative" }, { v: 1 }, { v: 1, dir: `/${"a".repeat(4096)}` }, [1], 1, null]) {
      expect(readVisualsArgument(Buffer.from(JSON.stringify(value)).toString("base64url"))).toBeNull();
    }
    expect(readVisualsArgument(42)).toBeNull();
    expect(readVisualsArgument("")).toBeNull();
    const longest = `/${"a".repeat(4095)}`;
    expect(readVisualsArgument(visualsArgument(longest))).toStrictEqual({ v: 1, dir: longest });
  });

  it("tells the model the rules: the reference block, pinned CDN versions, icons, and the way back", () => {
    const prompt = visualsPrompt("/v");

    expect(prompt).toContain('```visual\n{"path":"/v/<name>.html","title":"<short title>"}\n```');
    for (const host of VISUAL_CDN_HOSTS) expect(prompt).toContain(host);
    expect(prompt).toContain("full version pinned");
    expect(prompt).toContain(VISUAL_ICONS.join(", "));
    expect(prompt).toContain("window.atrium.sendMessage(text)");
    expect(prompt).toContain("at most 4000 characters, once a second");
    expect(prompt).toContain("No network");
  });

  it("asks for exact pinned versions, and ?bundle on esm.sh so no range-versioned dependency is asked for", () => {
    const prompt = visualsPrompt("/v");

    expect(prompt).toContain("always with the exact full version pinned in the address");
    expect(prompt).toContain(
      "On esm.sh always add ?bundle (d3@7.9.0?bundle), so its dependencies come inlined in one file",
    );
    expect(prompt).toContain("import their dependencies by version range, and those requests are blocked");
  });

  it("words the instructions exactly as reviewed", () => {
    expect(visualsPrompt("/v")).toMatchInlineSnapshot(`
      "You can show the user an interactive visual inline in your reply: a small HTML fragment that Atrium runs in a sandbox at the place you reference it.

      When to make one: only for something with steps, changing state or conditions to compare (two transactions interleaving, a request passing middleware, an algorithm step by step), and only when it clearly explains better than text. Use a Mermaid block for static structure and a Markdown table for tables. Do not mention the implementation in your text (no "I wrote an HTML file"); explain in the reply, keep the fragment to the visual itself.

      How: write the fragment to a file in /v (create the directory if needed), with a name ending in .html, then put this code block in your reply where it should appear:
      \`\`\`visual
      {"path":"/v/<name>.html","title":"<short title>"}
      \`\`\`
      To change a visual, edit the same file and reference it again in that reply; every card showing the file reloads.

      Rules for the fragment:
      - A fragment only: no <!doctype>, <html>, <head> or <body>. Under 1 MB. Give its root element a unique id.
      - No network: fetch, XMLHttpRequest, WebSocket and EventSource are blocked.
      - Libraries and fonts load only from https://cdnjs.cloudflare.com, https://cdn.jsdelivr.net, https://esm.sh, https://unpkg.com, https://fonts.googleapis.com, https://fonts.gstatic.com, always with the exact full version pinned in the address (d3@7.9.0, /ajax/libs/d3/7.9.0/...); an address without one, or with a range or a tag such as @latest, is blocked. On esm.sh always add ?bundle (d3@7.9.0?bundle), so its dependencies come inlined in one file: without it the modules it serves import their dependencies by version range, and those requests are blocked; on jsDelivr's /gh/ pin a whole commit or a vX.Y.Z tag.
      - Write your own styles. To follow Atrium's light and dark, use these CSS variables: --surface-1, --surface-2, --surface-3, --code, --text, --text-2, --text-3, --text-muted, --text-dim, --line, --line-soft, --line-strong, --hover, --selected, --tint, --on-tint, --attn, --danger, --ok, --diff-add-bg, --diff-del-bg, --font-sans, --font-mono, --fs, --fs-sm, --fs-xs, --r-sm, --r, --r-md.
      - Icons: <i data-icon="name"></i> with one of play, pause, stop, next, previous, refresh, reset, chevron-left, chevron-right, chevron-up, chevron-down, arrow-left, arrow-right, arrow-up, arrow-down, check, close, check-circle, cancel-circle, plus, minus, info, alert, help, search, settings, clock, database, file, folder, lock, unlock, user, server, computer, cloud, git-branch, git-commit, git-merge, flash, key, eye, code, terminal, sparkles, shuffle, sort, expand, shrink, bug, layers, link, globe, flag, star, heart, delete, copy, cpu, chart-line, chart-bar, pie-chart, grid. Do not draw icons or load an icon library.
      - To send the user's answer back, call window.atrium.sendMessage(text) from a click handler; it reaches you as the user's message. It only works right after the user clicks in the visual, at most 4000 characters, once a second.
      - The visual cannot read the conversation or files, call tools, or receive your replies."
    `);
  });

  it("offers a common subset of icons, each named once", () => {
    expect(new Set(VISUAL_ICONS).size).toBe(VISUAL_ICONS.length);
    for (const name of VISUAL_ICONS) expect(name).toMatch(/^[a-z]+(?:-[a-z]+)*$/u);
  });
});
