import { VISUAL_ICONS } from "@atrium/pi";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { VISUAL_CSP, iconSvg, visualPage } from "./shell";

describe("the visual's frame", () => {
  it("sends the policy SPEC-0007 sets, opaque even when opened on its own", () => {
    const cdn =
      "https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://esm.sh https://unpkg.com https://fonts.googleapis.com https://fonts.gstatic.com";
    expect(VISUAL_CSP).toBe(
      [
        "default-src 'none'",
        `script-src 'unsafe-inline' ${cdn} atrium-visual:`,
        `style-src 'unsafe-inline' ${cdn} atrium-visual:`,
        `img-src data: blob: ${cdn}`,
        `font-src data: ${cdn} atrium-visual:`,
        "media-src data: blob:",
        "worker-src blob:",
        "connect-src 'none'",
        "frame-src 'none'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
        "sandbox allow-scripts",
      ].join("; "),
    );
    expect(VISUAL_CSP).not.toContain("unsafe-eval");
  });

  it("wraps the fragment after its bridge, which offers only sendMessage", () => {
    const page = visualPage('<div id="lesson"><script>window.ran = 1</script></div>');

    expect(page.startsWith("<!doctype html>")).toBe(true);
    expect(page.indexOf("window.atrium")).toBeLessThan(page.indexOf('<div id="lesson">'));
    expect(page).toContain('<body><div id="lesson"><script>window.ran = 1</script></div></body>');
    expect(page).toContain("sendMessage");
    expect(page).toContain("navigator.userActivation");
    expect(page).toContain('"ui/message"');
    expect(page).toContain('"ui/initialize"');
    expect(page).toContain('"ui/notifications/size-changed"');
    expect(page).toContain('"atrium/notifications/activity"');
  });

  it("takes WebRTC away from the frame before anything else runs, for good", () => {
    const page = visualPage("x");
    const bridge = page.slice(page.indexOf("<script>") + "<script>".length, page.indexOf("</script>"));
    const frame = createContext({});
    runInContext(
      `globalThis.window = globalThis;
      for (const name of ["RTCPeerConnection", "webkitRTCPeerConnection", "RTCDataChannel", "RTCIceCandidate", "AbortController"]) {
        Object.defineProperty(globalThis, name, { value: function Interface() {}, writable: true, configurable: true });
      }`,
      frame,
    );
    // The realm has no DOM, so the bridge stops at its first use of `document`: what came before ran.
    expect(() => runInContext(bridge, frame)).toThrow("document is not defined");

    // Read back as JSON: arrays made in the other realm have that realm's prototype.
    expect(
      JSON.parse(
        runInContext(
          `JSON.stringify(["RTCPeerConnection", "webkitRTCPeerConnection", "RTCDataChannel", "RTCIceCandidate", "AbortController"].map(
          (name) => {
            const held = Object.getOwnPropertyDescriptor(window, name);
            return [name, typeof window[name], held.configurable, held.writable];
          }))`,
          frame,
        ),
      ),
    ).toStrictEqual([
      ["RTCPeerConnection", "undefined", false, false],
      ["webkitRTCPeerConnection", "undefined", false, false],
      ["RTCDataChannel", "undefined", false, false],
      ["RTCIceCandidate", "undefined", false, false],
      ["AbortController", "function", true, true],
    ]);
    expect(
      runInContext(
        `delete window.RTCPeerConnection;
        try { Object.defineProperty(window, "RTCPeerConnection", { value: 1 }); } catch {}
        window.RTCPeerConnection = 2;
        typeof window.RTCPeerConnection`,
        frame,
      ),
    ).toBe("undefined");
  });

  it("keeps a fragment's closing script tag from ending the bridge's own data early", () => {
    const page = visualPage("x");
    const bridge = page.slice(page.indexOf("<script>"), page.indexOf("</script>"));

    expect(bridge).toContain('const icons = {"play":"\\u003csvg viewBox=');
    expect(bridge).toContain("\\u003c/path>");
    expect(bridge).not.toContain("</");
    expect(page).toContain("html[data-atrium-waiting] body { visibility: hidden; }");
  });

  it("draws every offered icon from Hugeicons at Atrium's line width, and nothing for another name", () => {
    for (const name of VISUAL_ICONS) {
      const svg = iconSvg(name);
      expect(svg).toMatch(
        /^<svg viewBox="0 0 24 24" width="24" height="24" fill="none" aria-hidden="true">.+<\/svg>$/u,
      );
      expect(svg).not.toMatch(/strokeWidth|strokeLinecap|key=/u);
    }
    expect(iconSvg("play")).toContain('stroke-width="1.75"');
    expect(iconSvg("play")).toMatch(
      /^<svg [^>]+><path d="M18\.8906 [^"]+" stroke="currentColor" stroke-linejoin="round" stroke-width="1\.75"><\/path><\/svg>$/u,
    );
    expect(iconSvg("play")).toContain('stroke-linejoin="round"');
    expect(iconSvg("not-an-icon")).toBe("");
  });
});
