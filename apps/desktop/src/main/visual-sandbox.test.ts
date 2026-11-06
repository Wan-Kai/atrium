import { describe, expect, it } from "vitest";
import {
  VISUAL_CDN_HOSTS,
  captureRect,
  isPinnedCdnUrl,
  visualContentSecurityPolicy,
  visualHostPath,
  visualRequestAllowed,
} from "./visual-sandbox";

describe("the visual's policy", () => {
  it("is the policy SPEC-0007 writes, kept opaque on its own", () => {
    const cdn = VISUAL_CDN_HOSTS.join(" ");
    expect(VISUAL_CDN_HOSTS).toStrictEqual([
      "https://cdnjs.cloudflare.com",
      "https://cdn.jsdelivr.net",
      "https://esm.sh",
      "https://unpkg.com",
      "https://fonts.googleapis.com",
      "https://fonts.gstatic.com",
    ]);
    expect(visualContentSecurityPolicy()).toBe(
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
  });
});

describe("isPinnedCdnUrl", () => {
  it.each([
    "https://cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.min.js",
    "https://cdn.jsdelivr.net/npm/@observablehq/plot@0.6.16/dist/plot.umd.min.js",
    "https://cdn.jsdelivr.net/gh/user/repo@v1.2.3/file.js",
    "https://cdn.jsdelivr.net/gh/user/repo@0a1b2c3d4e5f60718293a4b5c6d7e8f901a2b3c4/file.js",
    "https://esm.sh/node/process.mjs",
    "https://esm.sh/node/string_decoder.mjs",
    "https://unpkg.com/d3@7.9.0/dist/d3.min.js",
    "https://unpkg.com/@scope/pkg@1.0.0-beta.2/index.js",
    "https://esm.sh/d3@7.9.0",
    "https://esm.sh/d3@7.9.0/es2022/d3.mjs",
    "https://esm.sh/v135/d3-array@3.2.4/es2022/d3-array.mjs",
    "https://esm.sh/@preact/signals@1.2.3?bundle",
    "https://cdnjs.cloudflare.com/ajax/libs/d3/7.9.0/d3.min.js",
    "https://cdn.jsdelivr.net/npm/d3@10.11.12/dist/d3.min.js",
    "https://cdn.jsdelivr.net/npm/d3@7.9.0-rc.1+build.5",
    "https://cdn.jsdelivr.net/gh/user/repo@1.2.3/file.js",
    "https://cdn.jsdelivr.net/gh/user/repo@v10.20.30-beta.1/file.js",
    "https://esm.sh/stable/d3@7.9.0",
    "https://unpkg.com/d3@7.9.0",
    "https://cdnjs.cloudflare.com/ajax/libs/three.js/0.160.0/three.module.min.js",
    "https://fonts.googleapis.com/css2?family=Inter",
    "https://fonts.gstatic.com/s/inter/v13/a.woff2",
  ])("lets %s through", (url) => {
    expect(isPinnedCdnUrl(new URL(url))).toBe(true);
  });

  it.each([
    "https://cdn.jsdelivr.net/npm/d3/dist/d3.min.js",
    "https://cdn.jsdelivr.net/npm/d3@7/dist/d3.min.js",
    "https://cdn.jsdelivr.net/npm/d3@latest/dist/d3.min.js",
    "https://cdn.jsdelivr.net/npm/d3@^7.9.0",
    "https://cdn.jsdelivr.net/gh/user/repo/file.js",
    "https://cdn.jsdelivr.net/gh/user/repo@master/file.js",
    "https://cdn.jsdelivr.net/combine/npm/d3@7.9.0",
    "https://unpkg.com/d3",
    "https://unpkg.com/d3@7/dist/d3.min.js",
    "https://unpkg.com/d3@latest",
    "https://esm.sh/d3",
    "https://esm.sh/d3@7",
    "https://esm.sh/d3@latest",
    "https://cdnjs.cloudflare.com/ajax/libs/d3/7/d3.min.js",
    "https://cdnjs.cloudflare.com/ajax/libs/d3/latest/d3.min.js",
    "https://cdnjs.cloudflare.com/d3.min.js",
    "http://cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.min.js",
    "https://cdn.jsdelivr.net:8443/npm/d3@7.9.0/dist/d3.min.js",
    "https://evil.example/npm/d3@7.9.0/dist/d3.min.js",
    "https://user:pass@unpkg.com/d3@7.9.0",
    "https://:pass@unpkg.com/d3@7.9.0",
    "https://unpkg.com:8443/d3@7.9.0",
    "https://unpkg.com/@7.9.0",
    "https://unpkg.com/@scope",
    "https://unpkg.com/d3@7.9.0x",
    "https://unpkg.com/d3@x7.9.0",
    "https://cdn.jsdelivr.net/gh/user",
    "https://cdn.jsdelivr.net/gh/user/@v1.2.3/file.js",
    "https://cdn.jsdelivr.net/gh/user/repo@abc12/file.js",
    "https://cdn.jsdelivr.net/gh/user/repo@abc1234/file.js",
    "https://cdn.jsdelivr.net/gh/user/repo@0a1b2c3d4e5f60718293a4b5c6d7e8f901a2b3c/file.js",
    "https://cdn.jsdelivr.net/gh/user/repo@0a1b2c3d4e5f60718293a4b5c6d7e8f901a2b3c4d/file.js",
    "https://esm.sh/d3-array@3?target=es2022",
    "https://esm.sh/base64-js@^1.3.1?target=es2022",
    "https://esm.sh/node/process.js",
    "https://esm.sh/node/a/b.mjs",
    "https://esm.sh/node/.mjs",
    "https://esm.sh/node/Process.mjs",
    "https://esm.sh/node/process.mjs/x",
    "https://cdn.jsdelivr.net/gh/user/repo@v1.2.3x/file.js",
    "https://cdn.jsdelivr.net/gh/user/repo@xv1.2.3/file.js",
    "https://cdn.jsdelivr.net/gh/user/repo@1.2/file.js",
    "https://cdn.jsdelivr.net/gh/user/repo@v1.2.3-/file.js",
    "https://esm.sh/xv135/d3@7.9.0",
    "https://esm.sh/v135x/d3@7.9.0",
    "https://cdnjs.cloudflare.com/ajax/libs//7.9.0/d3.min.js",
    "https://cdnjs.cloudflare.com/ajax/lib/d3/7.9.0/d3.min.js",
    "https://cdnjs.cloudflare.com/x/libs/d3/7.9.0/d3.min.js",
  ])("stops %s", (url) => {
    expect(isPinnedCdnUrl(new URL(url))).toBe(false);
  });
});

describe("visualRequestAllowed", () => {
  const page = "atrium://app/";
  /** The app's page and the host, whose requests of no frame are the app's own. */
  const apps = ["atrium://app", "http://127.0.0.1:4000", "ws://127.0.0.1:4000"];

  it("leaves the app's own page alone", () => {
    expect(visualRequestAllowed("https://example.com/a.png", { kind: "page" }, apps)).toBe(true);
    expect(visualRequestAllowed("https://cdn.jsdelivr.net/npm/d3/x.js", { kind: "page" }, apps)).toBe(true);
    expect(page).toBe("atrium://app/");
  });

  it("lets a request of no frame, a worker's or the main process's, reach only the app, the host and what a visual may", () => {
    const none = { kind: "none" } as const;
    expect(
      [
        "atrium://app/assets/highlight.worker.js",
        "http://127.0.0.1:4000/visual/x/a.html",
        "ws://127.0.0.1:4000/",
        `atrium-visual://${"a".repeat(32)}/a.html`,
        "data:text/plain,a",
        "blob:atrium-visual://x/1",
        "https://unpkg.com/d3@7.9.0/dist/d3.min.js",
        "http://127.0.0.1:4001/",
        "http://localhost:4000/",
        "atrium://other/",
        "https://example.com/?secret=1",
        "https://unpkg.com/d3",
        "file:///etc/passwd",
        "not a url",
      ].map((url) => visualRequestAllowed(url, none, apps)),
    ).toStrictEqual([true, true, true, true, true, true, true, false, false, false, false, false, false, false]);
  });

  it("lets a frame inside the page load only its own scheme, data, blobs and pinned CDN addresses", () => {
    const frame = { kind: "subframe", navigation: false } as const;
    expect(
      [
        `atrium-visual://${"a".repeat(32)}/a.html`,
        "data:text/plain,a",
        "blob:atrium-visual://x/1",
        "https://unpkg.com/d3@7.9.0/dist/d3.min.js",
        "https://fonts.gstatic.com/s/a.woff2",
        "https://unpkg.com/d3",
        "https://example.com/?secret=1",
        "http://127.0.0.1:4000/",
        "ws://127.0.0.1:4000/",
        "atrium://app/index.html",
        "file:///etc/passwd",
        "not a url",
      ].map((url) => visualRequestAllowed(url, frame, apps)),
    ).toStrictEqual([true, true, true, true, true, false, false, false, false, false, false, false]);
  });
});

describe("a visual navigating itself", () => {
  it("stays on its own scheme, never a CDN page, data or blob, where its CSP would not follow", () => {
    const navigation = { kind: "subframe", navigation: true } as const;
    expect(
      [
        `atrium-visual://${"a".repeat(32)}/a.html`,
        "https://unpkg.com/evil@1.0.0/x.html",
        "data:text/html,x",
        "blob:atrium-visual://x/1",
      ].map((url) => visualRequestAllowed(url, navigation, ["atrium://app"])),
    ).toStrictEqual([true, false, false, false]);
  });
});

describe("visualHostPath", () => {
  it("forwards a visual's address to the host by its token, and nothing else", () => {
    const token = "0123456789abcdef0123456789abcdef";
    expect(visualHostPath(`atrium-visual://${token}/2-03%20isolation.html?v=12`)).toBe(
      `/visual/${token}/2-03%20isolation.html`,
    );
    for (const url of [
      `atrium-visual://${token}/`,
      `atrium-visual://${token}/a/b.html`,
      `atrium-visual://${token.toUpperCase()}x/a.html`,
      "atrium-visual://short/a.html",
      `atrium-visual://a${token}/a.html`,
      `atrium-visual://${token}a/a.html`,
      `atrium://${token}/a.html`,
      "atrium-visual://../a.html",
      "not a url",
    ]) {
      expect([url, visualHostPath(url)]).toStrictEqual([url, null]);
    }
  });
});

describe("captureRect", () => {
  const bounds = { width: 1280, height: 820 };

  it("takes a rectangle touching the window's edges", () => {
    expect(captureRect({ x: 0, y: 0, width: 1280, height: 820 }, bounds)).toStrictEqual({
      x: 0,
      y: 0,
      width: 1280,
      height: 820,
    });
  });

  it("takes a whole, finite rectangle inside the window, rounded to pixels", () => {
    expect(captureRect({ x: 10.4, y: 20.6, width: 600.2, height: 300 }, bounds)).toStrictEqual({
      x: 10,
      y: 21,
      width: 600,
      height: 300,
    });
  });

  it.each([
    [null],
    ["0,0,10,10"],
    [{ x: 0, y: 0, width: 0, height: 10 }],
    [{ x: -1, y: 0, width: 10, height: 10 }],
    [{ x: 0, y: 0, width: 1281, height: 10 }],
    [{ x: 1000, y: 0, width: 300, height: 10 }],
    [{ x: 0, y: 800, width: 10, height: 30 }],
    [{ x: Number.NaN, y: 0, width: 10, height: 10 }],
    [{ x: 0, y: 0, width: Number.POSITIVE_INFINITY, height: 10 }],
    [{ x: 0, y: 0, width: "10", height: 10 }],
    [{ x: 0, y: 0, width: 10, height: 0 }],
    [{ x: 0, y: -1, width: 10, height: 10 }],
    [{ x: 0, y: 0, width: 10 }],
  ])("refuses %j", (value) => {
    expect(captureRect(value, bounds)).toBeNull();
  });
});
