import { type FauxReply } from "@atrium/testkit";
import { type ElectronApplication, type FrameLocator, type Page, expect, test } from "@playwright/test";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { createSocket } from "node:dgram";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fauxPiEnvironment } from "./faux-pi";
import { launchApp } from "./launch";
import { send } from "./messages";

/**
 * A local server that counts every request: anything a visual sends out would reach it.
 *
 * @remarks
 * The visuals try to reach it every way they can; a single request is an escape.
 *
 * @sideEffects Listens on 127.0.0.1.
 * @returns Its port, the paths it was asked for, and how to stop it.
 */
async function trap(): Promise<{ port: number; udpPort: number; asked: string[]; close: () => Promise<void> }> {
  const asked: string[] = [];
  const udp = createSocket("udp4");
  udp.on("message", () => asked.push("udp"));
  await new Promise<void>((done) => udp.bind(0, "127.0.0.1", done));
  const server: Server = createServer((request, response) => {
    asked.push(request.url ?? "");
    response.end("window.trapped = true;");
  });
  server.on("upgrade", (request, socket) => {
    asked.push(`upgrade ${request.url ?? ""}`);
    socket.destroy();
  });
  server.on("connection", () => asked.push("connection"));
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return {
    port: (server.address() as AddressInfo).port,
    udpPort: udp.address().port,
    asked,
    close: async () => {
      udp.close();
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}

/**
 * A fragment that tries every escape SPEC-0007 names and writes what happened into `#out`.
 *
 * @remarks
 * Each attempt is `ok` or `blocked`; the CDN ones load through a stand-in for the network the
 * test installs, so a pinned address loads and the unpinned ones are told apart from no network.
 *
 * @sideEffects none
 * @param port - The trap's port.
 * @returns The fragment.
 */
function probe(port: number, udpPort: number): string {
  const trapUrl = `http://127.0.0.1:${port}`;
  return `<div id="probe" style="padding:12px">
<button id="answer" style="width:160px;height:48px">选 B</button>
<span id="icon"><i data-icon="play"></i></span>
<pre id="out">running</pre>
<script>
const results = {};
const attempt = async (name, run) => {
  try { await run(); results[name] = "ok"; } catch { results[name] = "blocked"; }
};
const load = (src) => new Promise((resolve, reject) => {
  const script = document.createElement("script");
  script.src = src;
  script.onload = resolve;
  script.onerror = reject;
  document.head.append(script);
});
(async () => {
  await attempt("fetch", () => fetch("${trapUrl}/fetch"));
  await attempt("xhr", () => new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("GET", "${trapUrl}/xhr");
    request.onload = resolve;
    request.onerror = reject;
    request.send();
  }));
  await attempt("websocket", () => new Promise((resolve, reject) => {
    const socket = new WebSocket("ws://127.0.0.1:${port}/ws");
    socket.onopen = resolve;
    socket.onerror = reject;
  }));
  await attempt("image", () => new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = resolve;
    image.onerror = reject;
    image.src = "${trapUrl}/image.png";
  }));
  await attempt("parent", () => parent.document.body.innerHTML);
  await attempt("open", () => { if (window.open("${trapUrl}/open") === null) throw new Error("no window"); });
  await attempt("top", () => { top.location.href = "${trapUrl}/top"; });
  await attempt("camera", () => navigator.mediaDevices.getUserMedia({ video: true }));
  await attempt("script", () => load("${trapUrl}/script.js"));
  await attempt("pinned", () => load("https://cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.min.js"));
  await attempt("bare", () => load("https://cdn.jsdelivr.net/npm/d3/dist/d3.min.js"));
  await attempt("major", () => load("https://unpkg.com/d3@7/dist/d3.min.js"));
  await attempt("latest", () => load("https://esm.sh/d3@latest"));
  await attempt("cdnjs", () => load("https://cdnjs.cloudflare.com/ajax/libs/d3/7.9.0/d3.min.js"));
  // A pinned address whose answer sends it on to the trap: the next hop is checked again.
  await attempt("redirect", () => load("https://cdn.jsdelivr.net/npm/redirect@1.0.0/to-trap.js"));
  // DNS prefetching of names the fragment makes up: the net log must not resolve any.
  const control = document.createElement("meta");
  control.httpEquiv = "x-dns-prefetch-control";
  control.content = "on";
  document.head.append(control);
  for (const [rel, host] of [["dns-prefetch", "a"], ["preconnect", "b"], ["prefetch", "c"]]) {
    const link = document.createElement("link");
    link.rel = rel;
    link.href = "https://" + host + ".dns-probe-atrium.example/";
    document.head.append(link);
  }
  const anchor = document.createElement("a");
  anchor.href = "https://d.dns-probe-atrium.example/";
  anchor.textContent = "d";
  document.body.append(anchor);
  await attempt("worker", () => new Promise((resolve, reject) => {
    const code = "fetch('${trapUrl}/worker').then(() => postMessage('ok'), () => postMessage('blocked'))";
    const worker = new Worker(URL.createObjectURL(new Blob([code], { type: "text/javascript" })));
    worker.onmessage = (event) => (event.data === "ok" ? resolve() : reject(new Error("blocked")));
    worker.onerror = reject;
  }));
  const ice = [{ urls: "stun:127.0.0.1:${udpPort}" }, { urls: "turn:127.0.0.1:${port}?transport=tcp", username: "u", credential: "p" }];
  const connect = async (Peer) => {
    const peer = new Peer({ iceServers: ice, iceTransportPolicy: "all" });
    peer.createDataChannel("x");
    await peer.setLocalDescription(await peer.createOffer());
    await new Promise((resolve) => setTimeout(resolve, 2000));
    peer.close();
  };
  await attempt("rtc", () => connect(window.RTCPeerConnection));
  await attempt("rtc-webkit", () => connect(window.webkitRTCPeerConnection));
  await attempt("rtc-restore", () => {
    delete window.RTCPeerConnection;
    Object.defineProperty(window, "RTCPeerConnection", { value: function Peer() {}, configurable: true });
    if (typeof window.RTCPeerConnection !== "function") throw new Error("still gone");
  });
  await attempt("rtc-nested", () => {
    const frame = document.createElement("iframe");
    document.body.append(frame);
    return connect(frame.contentWindow.RTCPeerConnection);
  });
  // A child document gets its own realm; each tries WebRTC itself and reports back.
  const childCode = "<script>(async () => { try { const peer = new RTCPeerConnection({ iceServers: " + JSON.stringify(ice) + " }); peer.createDataChannel('x'); await peer.setLocalDescription(await peer.createOffer()); parent.postMessage('child-rtc', '*'); } catch { parent.postMessage('child-blocked', '*'); } })();<\\/script>";
  const child = (start) => new Promise((resolve, reject) => {
    const heard = (event) => {
      if (event.data !== "child-rtc" && event.data !== "child-blocked") return;
      removeEventListener("message", heard);
      if (event.data === "child-rtc") setTimeout(resolve, 2000); else reject(new Error("blocked"));
    };
    addEventListener("message", heard);
    try { start(); } catch (error) { removeEventListener("message", heard); reject(error); return; }
    setTimeout(() => { removeEventListener("message", heard); reject(new Error("silent")); }, 3000);
  });
  const frameWith = (set) => { const frame = document.createElement("iframe"); set(frame); document.body.append(frame); return frame; };
  await attempt("rtc-srcdoc", () => child(() => frameWith((frame) => { frame.srcdoc = childCode; })));
  await attempt("rtc-blank-write", () => child(() => {
    frameWith(() => {});
    const doc = window[window.length - 1].document;
    doc.open(); doc.write(childCode); doc.close();
  }));
  await attempt("rtc-data-frame", () => child(() => frameWith((frame) => { frame.src = "data:text/html," + encodeURIComponent(childCode); })));
  await attempt("rtc-blob-frame", () => child(() => frameWith((frame) => { frame.src = URL.createObjectURL(new Blob([childCode], { type: "text/html" })); })));
  await attempt("rtc-worker", () => new Promise((resolve, reject) => {
    const code = "try { new RTCPeerConnection(); postMessage('ok'); } catch { try { new RTCDataChannel(); postMessage('ok'); } catch { postMessage('blocked'); } }";
    const worker = new Worker(URL.createObjectURL(new Blob([code], { type: "text/javascript" })));
    worker.onmessage = (event) => (event.data === "ok" ? resolve() : reject(new Error("blocked")));
    worker.onerror = reject;
  }));
  const hint = document.createElement("link");
  hint.rel = "preconnect";
  hint.href = "${trapUrl}";
  document.head.append(hint);
  await attempt("self-send", () => window.atrium.sendMessage("自己发的").then((sent) => { if (!sent) throw new Error("dropped"); }));
  document.getElementById("out").textContent = JSON.stringify(results);
})();
document.getElementById("answer").addEventListener("click", () => window.atrium.sendMessage("选 B"));
</script></div>`;
}

/**
 * A fragment that navigates its own frame away: to the trap, a page of the CDN, `data:` or `blob:`.
 *
 * @remarks
 * Only `atrium-visual:` keeps the visual's CSP, so every one of them must stay where it is.
 *
 * @sideEffects none
 * @param target - Where it goes: an address, or `blob` for a page it makes itself.
 * @returns The fragment.
 */
function runaway(target: string): string {
  const where =
    target === "blob"
      ? 'URL.createObjectURL(new Blob(["<p>away</p>"], { type: "text/html" }))'
      : JSON.stringify(target);
  return `<p id="leaving">leaving</p><script>setTimeout(() => { location.href = ${where}; }, 50);</script>`;
}

/** Where the runaway visuals try to go, by their file's name. */
function runaways(port: number): [string, string][] {
  return [
    ["runaway", `http://127.0.0.1:${port}/away?secret=1`],
    ["to-cdn", "https://cdn.jsdelivr.net/npm/page@1.0.0/page.html"],
    ["to-data", "data:text/html,<p>away</p>"],
    ["to-blob", "blob"],
  ];
}

/** The faux model writes the two visuals with pi's own tool, then references them in its reply. */
function replies(port: number, udpPort: number): FauxReply[] {
  return [
    {
      blocks: [
        {
          type: "toolCall",
          id: "w1",
          name: "write",
          arguments: { path: "{{visuals}}/probe.html", content: probe(port, udpPort) },
        },
      ],
    },
    ...runaways(port).map(([name, target], index): FauxReply => ({
      blocks: [
        {
          type: "toolCall",
          id: `w${index + 2}`,
          name: "write",
          arguments: { path: `{{visuals}}/${name}.html`, content: runaway(target) },
        },
      ],
    })),
    {
      blocks: [
        {
          type: "text",
          text: `先看隔离级别：\n\n\`\`\`visual\n{"path":"{{visuals}}/probe.html","title":"沙箱检查"}\n\`\`\`\n\n${runaways(
            port,
          )
            .map(([name]) => `\`\`\`visual\n{"path":"{{visuals}}/${name}.html"}\n\`\`\``)
            .join("\n\n")}`,
        },
      ],
    },
    { blocks: [{ type: "text", text: "收到你的回答。" }] },
  ];
}

/**
 * Makes the main process answer https requests itself, as a stand-in for the CDN.
 *
 * @remarks
 * The test never reaches the network; the request filter still sees each request first, so what
 * it stops never gets here.
 *
 * @sideEffects Registers an https handler on the default session.
 * @param app - The app.
 */
async function standInCdn(app: ElectronApplication, trapPort: number): Promise<void> {
  await app.evaluate(({ protocol }, port) => {
    const served: string[] = [];
    Reflect.set(globalThis, "cdnServed", served);
    protocol.handle("https", (request) => {
      served.push(new URL(request.url).pathname);
      if (request.url.includes("/redirect@1.0.0/"))
        return Response.redirect(`http://127.0.0.1:${port}/redirected`, 302);
      return new Response("window.cdnLoaded = true;", { headers: { "content-type": "text/javascript" } });
    });
  }, trapPort);
}

/**
 * The paths the CDN stand-in answered.
 *
 * @remarks
 * Set by `standInCdn`.
 *
 * @sideEffects none
 * @param app - The app.
 * @returns The paths.
 */
async function cdnServed(app: ElectronApplication): Promise<string[]> {
  return app.evaluate((): string[] => {
    const served: unknown = Reflect.get(globalThis, "cdnServed");
    return Array.isArray(served) ? served.map(String) : [];
  });
}

/**
 * The host names a net log shows looked up: the `host` of each host resolver event.
 *
 * @remarks
 * A request the filter stopped is in the log with its address too, so only the resolver's events
 * say a name went to DNS.
 *
 * @sideEffects none
 * @param log - The net log's text.
 * @returns The names.
 */
function resolvedNames(log: string): string[] {
  const parsed: unknown = JSON.parse(log);
  const types: unknown = Reflect.get(Object(Reflect.get(Object(parsed), "constants")), "logEventTypes");
  const resolver = new Set(
    Object.entries(Object(types))
      .filter(([name]) => name.startsWith("HOST_RESOLVER"))
      .map(([, id]) => id),
  );
  const events: unknown = Reflect.get(Object(parsed), "events");
  return (Array.isArray(events) ? events : [])
    .filter((event) => resolver.has(Reflect.get(Object(event), "type")))
    .map((event) => String(Reflect.get(Object(Reflect.get(Object(event), "params")), "host") ?? ""));
}

/**
 * Records what the app would open in the system browser, instead of opening it.
 *
 * @remarks
 * A visual's `window.open` must never get there; the trap would not see the browser's request.
 *
 * @sideEffects Replaces `shell.openExternal` in the main process.
 * @param app - The app.
 */
async function recordBrowserOpens(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ shell }) => {
    const opened: string[] = [];
    Reflect.set(globalThis, "browserOpened", opened);
    shell.openExternal = async (url) => {
      opened.push(url);
    };
  });
}

/**
 * Sends a key with ⌘ through the window's own input, as the keyboard would.
 *
 * @remarks
 * Playwright's keys go in over the debugging protocol; the main process's `before-input-event`
 * hears the window's own input, as it would a real key.
 *
 * @sideEffects Sends a key press and release to the first window.
 * @param app - The app.
 * @param keyCode - The key.
 */
async function commandKey(app: ElectronApplication, keyCode: string): Promise<void> {
  await app.evaluate(({ BrowserWindow }, key) => {
    const contents = BrowserWindow.getAllWindows()[0]?.webContents;
    contents?.sendInputEvent({ type: "keyDown", keyCode: key, modifiers: ["meta"] });
    contents?.sendInputEvent({ type: "keyUp", keyCode: key, modifiers: ["meta"] });
  }, keyCode);
}

/**
 * The frame of the n-th visual card.
 *
 * @remarks
 * Cards are in the order of the reply.
 *
 * @sideEffects none
 * @param window - The app's page.
 * @param index - Which card.
 * @returns The frame.
 */
function visual(window: Page, index: number): FrameLocator {
  return window.getByTestId("visual-frame").nth(index).contentFrame();
}

/**
 * Clicks the middle of an element inside a visual, with the press also seen by the app's main process.
 *
 * @remarks
 * Playwright's clicks go in over the debugging protocol and never reach `input-event`, so the
 * press Atrium binds a visual's message to would be missing. `sendInputEvent` does reach
 * `input-event`, but here never reaches the frame's own process. So the press goes in the real
 * way through the window first, then Playwright clicks the element.
 *
 * @sideEffects Sends a mouse press and release to the first window, then clicks the element.
 * @param app - The running app.
 * @param target - The element to click.
 */
async function pressInWindow(app: ElectronApplication, target: ReturnType<FrameLocator["locator"]>): Promise<void> {
  const box = await target.boundingBox();
  if (box === null) throw new Error("the element has no box");
  const point = { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
  await app.evaluate(({ BrowserWindow }, at) => {
    const contents = BrowserWindow.getAllWindows()[0]?.webContents;
    contents?.sendInputEvent({ type: "mouseDown", x: at.x, y: at.y, button: "left", clickCount: 1 });
    contents?.sendInputEvent({ type: "mouseUp", x: at.x, y: at.y, button: "left", clickCount: 1 });
  }, point);
  await target.click();
}

/**
 * How many messages the home's turn records mark as sent from a visual.
 *
 * @remarks
 * The host writes the record once the run's entries are read, a moment after the reply.
 *
 * @sideEffects Reads the records.
 * @param home - Atrium's home.
 * @returns The count; none while there are no records.
 */
async function visualSources(home: string): Promise<number> {
  const names = await readdir(join(home, "turns")).catch(() => []);
  const records = await Promise.all(names.map(async (name) => readFile(join(home, "turns", name), "utf8")));
  return records
    .map((record): unknown => Reflect.get(Object(JSON.parse(record)), "sources"))
    .flatMap((sources) => Object.values(Object(sources)))
    .filter((source) => Reflect.get(Object(source), "kind") === "visual").length;
}

test("runs a visual in its sandbox: no network, no parent, no popups, pinned CDN only, and only clicked messages", async () => {
  const server = await trap();
  const pi = await fauxPiEnvironment({ replies: replies(server.port, server.udpPort) });
  const launched = await launchApp(pi.env);
  try {
    const { window, app, home } = launched;
    await standInCdn(app, server.port);
    await recordBrowserOpens(app);
    const netLog = join(home, "net-log.json");
    await app.evaluate(async ({ netLog: log }, path) => log.startLogging(path), netLog);
    await send(window, "讲讲隔离级别");
    const cards = window.getByTestId("visual-card");
    await expect(cards).toHaveCount(5, { timeout: 30_000 });
    await expect(cards.first().getByTestId("visual-path")).toHaveText(/\/visuals\/[^/]+\/probe\.html$/u);

    const frame = visual(window, 0);
    await expect(frame.locator("#out")).not.toHaveText("running", { timeout: 15_000 });
    const results: unknown = JSON.parse(await frame.locator("#out").innerText());
    expect(results).toStrictEqual({
      fetch: "blocked",
      xhr: "blocked",
      websocket: "blocked",
      image: "blocked",
      parent: "blocked",
      open: "blocked",
      top: "blocked",
      camera: "blocked",
      script: "blocked",
      pinned: "ok",
      bare: "blocked",
      major: "blocked",
      latest: "blocked",
      cdnjs: "ok",
      redirect: "blocked",
      worker: "blocked",
      rtc: "blocked",
      "rtc-webkit": "blocked",
      "rtc-restore": "blocked",
      "rtc-nested": "blocked",
      "rtc-worker": "blocked",
      "rtc-srcdoc": "blocked",
      "rtc-blank-write": "blocked",
      "rtc-data-frame": "blocked",
      "rtc-blob-frame": "blocked",
      "self-send": "blocked",
    });
    // The frame's icon came from the host's list; the frame got Atrium's theme.
    await expect(frame.locator("#icon svg")).toHaveCount(1);
    await expect.poll(() => frame.locator("html").evaluate((root) => root.dataset["theme"])).toMatch(/^(light|dark)$/u);

    // Only a click in the frame sends, once a second at most, marked as from the visual.
    await pressInWindow(app, frame.locator("#answer"));
    await pressInWindow(app, frame.locator("#answer"));
    const sent = window.getByTestId("user-message").filter({ hasText: "选 B" });
    await expect(sent).toHaveCount(1, { timeout: 30_000 });
    await expect(sent.getByTestId("user-from-visual")).toHaveText("来自演示");
    await expect(window.getByTestId("user-message").filter({ hasText: "自己发的" })).toHaveCount(0);
    await expect(window.locator('[data-testid="reply"][data-streaming="false"]').last()).toHaveText("收到你的回答。", {
      timeout: 30_000,
    });

    // The visuals that tried to navigate away stayed where they were: none reached the trap, a
    // page of the CDN, `data:` or `blob:`; nothing reached the trap, not even by a redirect.
    // Each loads only in view, so each is brought into view in turn and let run.
    for (const card of (await cards.all()).slice(1)) {
      await card.scrollIntoViewIfNeeded();
      await expect(card.getByTestId("visual-frame")).toBeVisible();
      await window.waitForTimeout(500);
    }
    expect(
      window
        .frames()
        .map((one) => one.url())
        .filter((url) => /^(?:https?|data|blob):/u.test(url)),
    ).toStrictEqual([]);
    expect(server.asked).toStrictEqual([]);
    expect((await cdnServed(app)).filter((path) => path.endsWith("/page.html"))).toStrictEqual([]);
    // No visual's `window.open` reached the system browser.
    expect(await app.evaluate(() => Reflect.get(globalThis, "browserOpened"))).toStrictEqual([]);
    // Of the names the probe made up, only the one in `<link rel="dns-prefetch">` was looked up:
    // Chromium's frame setting, not `X-DNS-Prefetch-Control`, gates it, and Electron cannot turn
    // it off (a known leak, SPEC-0007 "风险与待定问题"). Preconnect, prefetch and links resolve nothing.
    await app.evaluate(async ({ netLog: log }) => log.stopLogging());
    const looked = resolvedNames(await readFile(netLog, "utf8")).filter((name) => name.includes("dns-probe-atrium"));
    expect([...new Set(looked)]).toStrictEqual(["https://a.dns-probe-atrium.example"]);

    // The source is remembered with the session's turn record.
    await expect.poll(() => visualSources(home)).toBe(1);
  } finally {
    await launched.close();
    await pi.cleanup();
    await server.close();
  }
});

test("follows light and dark, reloads a changed file, and keeps Atrium's shortcuts out while focused", async () => {
  const server = await trap();
  const pi = await fauxPiEnvironment({ replies: replies(server.port, server.udpPort) });
  const launched = await launchApp(pi.env);
  try {
    const { window, app } = launched;
    await standInCdn(app, server.port);
    await send(window, "讲讲隔离级别");
    const frame = visual(window, 0);
    await expect(frame.locator("#out")).not.toHaveText("running", { timeout: 30_000 });

    await app.evaluate(({ nativeTheme }) => {
      nativeTheme.themeSource = "dark";
    });
    await expect.poll(() => frame.locator("html").evaluate((root) => root.dataset["theme"])).toBe("dark");
    await app.evaluate(({ nativeTheme }) => {
      nativeTheme.themeSource = "light";
    });
    await expect.poll(() => frame.locator("html").evaluate((root) => root.dataset["theme"])).toBe("light");

    // Keys go to the visual while it has the focus: ⌘N opens no new chat.
    const tabs = window.getByRole("tab");
    const before = await tabs.count();
    // Right after the user typed in Atrium, while the page still has that activation, the
    // fragment focuses itself and posts past the bridge: still refused, it was not clicked.
    const box = window.getByRole("textbox", { name: "消息" });
    await box.click();
    await box.press("a");
    await box.press("Backspace");
    await frame.locator("html").evaluate(() => {
      document.getElementById("answer")?.focus();
      const message = { role: "user", content: { type: "text", text: "绕过外壳" } };
      parent.postMessage({ jsonrpc: "2.0", id: 99, method: "ui/message", params: message }, "*");
    });
    await frame.locator("#answer").focus();
    await window.keyboard.press("Meta+N");
    await window.waitForTimeout(300);
    await expect(tabs).toHaveCount(before);
    // A click outside gives the keys back.
    await window.getByRole("textbox", { name: "消息" }).click();
    await window.keyboard.press("Meta+N");
    await expect(tabs).toHaveText(["新会话"], { timeout: 30_000 });
    await window.getByRole("region", { name: "对话" }).getByTestId("chat-row").nth(1).click();
    await expect(window.getByTestId("visual-card")).toHaveCount(5, { timeout: 30_000 });
    await expect(window.getByTestId("user-message").filter({ hasText: "绕过外壳" })).toHaveCount(0);

    // The agent changes the file: the card shows the new version.
    const path = await window.getByTestId("visual-path").first().innerText();
    await writeFile(path, '<p id="changed">第二版</p>');
    await expect(visual(window, 0).locator("#changed")).toHaveText("第二版", { timeout: 15_000 });
  } finally {
    await launched.close();
    await pi.cleanup();
    await server.close();
  }
});

test("keeps ⌘W and ⌘, Atrium's while the focus is in a visual", async () => {
  const server = await trap();
  const pi = await fauxPiEnvironment({ replies: replies(server.port, server.udpPort) });
  const launched = await launchApp(pi.env);
  try {
    const { window, app } = launched;
    await standInCdn(app, server.port);
    await send(window, "讲讲隔离级别");
    const frame = visual(window, 0);
    await expect(frame.locator("#out")).not.toHaveText("running", { timeout: 30_000 });
    await frame.locator("#answer").focus();
    await expect.poll(() => window.evaluate(() => document.activeElement?.tagName)).toBe("IFRAME");

    await commandKey(app, ",");
    const settings = window.getByRole("dialog", { name: "设置" });
    await expect(settings).toBeVisible();
    await window.keyboard.press("Escape");
    await expect(settings).toHaveCount(0);

    await frame.locator("#answer").focus();
    await expect.poll(() => window.evaluate(() => document.activeElement?.tagName)).toBe("IFRAME");
    const tabs = window.getByRole("tab");
    const before = await tabs.count();
    await commandKey(app, "W");
    await expect(tabs).toHaveCount(before - 1);
  } finally {
    await launched.close();
    await pi.cleanup();
    await server.close();
  }
});
