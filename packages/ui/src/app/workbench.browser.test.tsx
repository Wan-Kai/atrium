import { CommandError, type SessionView } from "@atrium/client";
import { IDLE_CONTROL } from "@atrium/protocol";
import type { ReactNode } from "react";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import "../styles.css";
import { describeArchiveError, describeRestoreError } from "../sidebar/archive";
import { pageNotices, showNotice } from "../state/session-notices";
import { caughtDownloads } from "../test/downloads";
import { PROJECT, chat, fakeClient, session, workspace } from "../test/fake-client";
import { ConnectionStatus } from "./connection-status";
import { Workbench } from "./workbench";

const LOCAL = "wks_000000000000000a";
const FEATURE = "wks_000000000000000b";
const MERGED = "wks_000000000000000c";
const CHAT = "cht_a";

/**
 * A list with one project, three workspaces, a chat and some sessions, the client in the local
 * workspace.
 */
function list() {
  return {
    projects: [PROJECT],
    workspaces: [
      workspace({
        id: MERGED,
        branch: "fix/typo",
        createdAt: 9,
        merge: { dirty: false, ahead: 0, verdict: "merged", reason: null },
      }),
      workspace({
        id: FEATURE,
        branch: "feat/sidebar",
        createdAt: 5,
        merge: { dirty: true, ahead: 3, verdict: "pending", reason: null },
      }),
      workspace({
        id: LOCAL,
        kind: "local",
        branch: "main",
        dir: "/work/atrium",
        createdAt: null,
        external: false,
        merge: null,
      }),
    ],
    sessions: [
      session({ sessionId: "s1", containerId: LOCAL, prompt: "重构宿主" }),
      session({ sessionId: "s2", containerId: LOCAL, prompt: "调研 pi RPC", running: true }),
      session({ sessionId: "s3", containerId: FEATURE, name: "实现 sidebar" }),
      session({ sessionId: "c1", containerId: CHAT, prompt: "解释 merge-tree" }),
    ],
    chats: [chat({ id: CHAT, firstSessionId: "c1" })],
    layout: { container: LOCAL, tabs: { [LOCAL]: { open: ["s1", "s2"], active: "s1" } } },
  };
}

/**
 * The list, with six sessions needing the user and two that no longer do: errors, a question and
 * a login, from the newest error three minutes ago to the oldest fifty.
 */
function needing() {
  const initial = list();
  const minute = 60_000;
  /** An error not seen yet, set `minutesAgo`. */
  const error = (minutesAgo: number) => ({
    attention: { reason: "error" as const, at: Date.now() - minutesAgo * minute, cleared: false },
  });
  return {
    ...initial,
    sessions: [
      ...initial.sessions,
      session({ sessionId: "e1", containerId: FEATURE, name: "错一", ...error(30) }),
      session({ sessionId: "e2", containerId: LOCAL, name: "错二", ...error(3) }),
      session({ sessionId: "e3", containerId: CHAT, name: "错三", ...error(50) }),
      session({ sessionId: "e4", containerId: LOCAL, name: "错四", ...error(40) }),
      session({
        sessionId: "seen",
        containerId: LOCAL,
        ...error(1),
        attention: { ...error(1).attention, cleared: true },
      }),
      session({ sessionId: "gone", containerId: LOCAL, ...error(1), archived: true }),
      session({ sessionId: "a1", containerId: FEATURE, name: "问一", asking: Date.now() - 12 * minute }),
      session({
        sessionId: "k1",
        containerId: CHAT,
        name: "钥一",
        attention: { reason: "auth", at: 0, cleared: false },
      }),
    ],
  };
}

/**
 * How long each animation under an element takes and when it starts, the element's own first.
 *
 * @remarks
 * For the project's fold: the height, then each workspace row's fade.
 *
 * @sideEffects none
 * @param element - The fold.
 * @returns `[duration, delay]` per animation.
 */
function foldTimings(element: Element): unknown[][] {
  return [element, ...element.querySelectorAll("[data-fold-row]")].map((each) => {
    const timing = each.getAnimations()[0]?.effect?.getTiming();
    return [timing?.duration, timing?.delay];
  });
}

/**
 * The heights an element's first animation goes through.
 *
 * @sideEffects none
 * @param element - The animated element.
 * @returns The keyframes' heights.
 */
function heightFrames(element: Element): unknown[] {
  const effect = element.getAnimations()[0]?.effect as KeyframeEffect | undefined;
  return effect?.getKeyframes().map((frame) => frame["height"]) ?? [];
}

/**
 * Stops every animation under an element at its end, without finishing it.
 *
 * @remarks
 * Shows the last frame of a fold while it is still on screen.
 *
 * @sideEffects Pauses and seeks the animations.
 * @param element - The fold.
 */
function holdAtEnd(element: Element): void {
  for (const animation of element.getAnimations({ subtree: true })) {
    const timing = animation.effect?.getComputedTiming();
    animation.pause();
    animation.currentTime = timing?.endTime ?? 0;
  }
}

/**
 * The gap between the bottom of one element and the top of another.
 *
 * @sideEffects none
 * @param above - The upper element.
 * @param below - The lower element.
 * @returns The gap in pixels.
 */
function gap(above: Element, below: Element): number {
  return below.getBoundingClientRect().top - above.getBoundingClientRect().bottom;
}

/**
 * The project row's folder icons: which, how visible and scaled, and the transitions on each.
 *
 * @sideEffects none
 * @param row - The project row.
 * @returns One entry per icon.
 */
function folderIcons(row: Element): unknown[][] {
  return [...row.querySelectorAll<SVGElement>("[data-folder]")].map((icon) => [
    icon.dataset["folder"],
    getComputedStyle(icon).opacity,
    getComputedStyle(icon).scale,
    icon
      .getAnimations()
      .map((animation) => [(animation as CSSTransition).transitionProperty, animation.effect?.getTiming().duration])
      .toSorted(([a], [b]) => String(a).localeCompare(String(b))),
  ]);
}

/**
 * What a color, given as CSS (a variable, a mix), computes to on this page.
 *
 * @remarks
 * Lets a test compare a button's computed colors with the design tokens' without writing out
 * their values.
 *
 * @sideEffects Adds a probe element to the page and removes it.
 * @param color - The CSS color.
 * @returns Its computed `rgb(...)` form.
 */
function computedColor(color: string): string {
  const probe = document.createElement("span");
  probe.style.color = color;
  document.body.append(probe);
  const computed = getComputedStyle(probe).color;
  probe.remove();
  return computed;
}

/** The space, in pixels, between `element` and what follows it. */
function gapAfter(element: Element): number | undefined {
  const next = element.nextElementSibling?.getBoundingClientRect().left;
  return next === undefined ? undefined : next - element.getBoundingClientRect().right;
}

/**
 * Archives a chat with the button its row's hover shows.
 *
 * @sideEffects Hovers the chat's row and clicks its archive button.
 * @param screen - The rendered workbench.
 * @param name - The chat's name.
 */
async function archiveChatRow(screen: Awaited<ReturnType<typeof workbench>>["screen"], name: string) {
  const row = screen.getByTestId("chat-row").filter({ hasText: name });
  await row.hover();
  await row.getByRole("button", { name: `归档对话 ${name}` }).click();
}

/**
 * Opens a chat's "···" menu in the sidebar.
 *
 * @sideEffects Hovers the chat's row and clicks its menu button.
 * @param screen - The rendered workbench.
 * @param name - The chat's name.
 */
async function chatMenu(screen: Awaited<ReturnType<typeof workbench>>["screen"], name: string) {
  const row = screen.getByTestId("chat-row").filter({ hasText: name });
  await row.hover();
  await row.getByRole("button", { name: `对话 ${name}` }).click();
}

/**
 * The list with the chat's session c1 changed.
 *
 * @sideEffects none
 * @param fields - What changes.
 * @returns The list.
 */
function withC1(fields: Partial<ReturnType<typeof session>>) {
  const base = list();
  return {
    ...base,
    sessions: base.sessions.map((one) => (one.sessionId === "c1" ? { ...one, ...fields } : one)),
  };
}

/**
 * A list with two archived chats, one with a session left out of its archive, and the chat with
 * c1 not archived.
 */
function withArchivedChats() {
  const base = list();
  const minute = 60_000;
  return {
    ...base,
    sessions: [
      ...base.sessions,
      session({ sessionId: "a1", containerId: "cht_old", prompt: "解释 rebase", archived: true }),
      session({ sessionId: "a2", containerId: "cht_older", prompt: "写周报", archived: true }),
      // Not archived with its chat; the chat stays hidden all the same.
      session({ sessionId: "a3", containerId: "cht_older", prompt: "提纲" }),
    ],
    chats: [
      ...base.chats,
      chat({ id: "cht_older", firstSessionId: "a2", alias: "周报", archivedAt: Date.now() - 120 * minute }),
      chat({ id: "cht_old", firstSessionId: "a1", archivedAt: Date.now() - 5 * minute }),
    ],
  };
}

/**
 * Renders the workbench over a fake client.
 *
 * @remarks
 * The display mode follows the fake's preferences, as in the app.
 *
 * @sideEffects Renders; installs the display mode subscription until the test ends.
 * @param options - The list, how adding a project answers, and the folder the picker returns.
 * @returns The screen, the fake, the appearances sent to the window, and the addresses opened and
 * paths shown in the Finder.
 */
async function workbench(
  options: {
    initial?: Parameters<typeof fakeClient>[0];
    answers?: Parameters<typeof fakeClient>[1];
    picked?: string | null;
    status?: ReactNode;
  } = {},
) {
  // The size of the app's window, so the sidebar and tab bar sit side by side.
  await page.viewport(1280, 820);
  const fake = fakeClient(options.initial ?? list(), options.answers);
  const native: string[] = [];
  const opened: string[] = [];
  const revealed: string[] = [];
  const screen = await render(
    <Workbench
      client={fake.client}
      status={options.status ?? <span>已连接宿主</span>}
      pickDirectory={async () => options.picked ?? null}
      setNativeAppearance={(appearance) => native.push(appearance)}
      openUrl={(url) => opened.push(url)}
      reveal={(path) => revealed.push(path)}
      pathForFile={undefined}
    />,
  );
  return { screen, ...fake, native, opened, revealed };
}

describe("Workbench connection line", () => {
  it("takes no room once connected, and a line at the bottom while not", async () => {
    const connected = {
      status: "connected",
      traceId: "t",
      hostVersion: "0.1.0",
      hostInstanceId: "h1",
      installSeed: 1,
      logDir: "/l",
    } as const;
    const { screen } = await workbench({ status: <ConnectionStatus view={connected} /> });
    const footer = screen.container.querySelector("footer");

    await expect.element(screen.getByRole("status")).toHaveTextContent("已连接宿主 0.1.0");
    expect(footer?.getBoundingClientRect().height).toBe(0);
    await screen.rerender(
      <Workbench
        client={fakeClient(list()).client}
        status={<ConnectionStatus view={{ status: "reconnecting", attempt: 1, code: 1006 }} />}
        pickDirectory={undefined}
        setNativeAppearance={undefined}
        openUrl={() => undefined}
        reveal={undefined}
        pathForFile={undefined}
      />,
    );
    await expect.element(screen.getByRole("status")).toBeVisible();
    expect(screen.container.querySelector("footer")?.getBoundingClientRect().height).toBe(24);
  });
});

describe("Workbench sidebar", () => {
  it("lists a project's workspaces, local first, the merged one last, with merge states and running work", async () => {
    const { screen } = await workbench();

    const rows = screen.getByTestId("workspace-row");
    await expect.element(rows.nth(0)).toHaveTextContent("main");
    await expect.element(rows.nth(0).getByRole("img", { name: "运行中" })).toBeVisible();
    await expect.element(rows.nth(1).getByRole("img", { name: "运行中" })).not.toBeInTheDocument();
    await expect.element(rows.nth(1)).toHaveTextContent("feat/sidebar3未提交");
    await expect.element(rows.nth(2)).toHaveTextContent("fix/typo已合并");
    // The arrow and the merge mark are icons, not characters of the font.
    expect(rows.nth(1).getByTitle("未合并：比主干多 3 个提交").element().querySelector("svg")).not.toBeNull();
    expect(
      rows
        .nth(2)
        .getByTitle(/^改动已全部进入主干/)
        .element()
        .querySelector("svg"),
    ).not.toBeNull();
    await expect.element(rows.nth(0)).toHaveAttribute("aria-current", "true");
    await expect.element(rows.nth(0)).toHaveAttribute("title", "本地工作区（项目目录）");
  });

  it("shows each session's highest status on its tab, and the highest of a workspace's live sessions on its row", async () => {
    const initial = list();
    const { screen } = await workbench({
      initial: {
        ...initial,
        sessions: [
          session({ sessionId: "s1", containerId: LOCAL, attention: { reason: "error", at: 1, cleared: true } }),
          ...initial.sessions.slice(1),
          session({ sessionId: "s4", containerId: FEATURE, attention: { reason: "auth", at: 1, cleared: false } }),
          session({ sessionId: "s5", containerId: MERGED, asking: 1, archived: true }),
        ],
      },
    });

    const rows = screen.getByTestId("workspace-row");
    await expect.element(rows.nth(0).getByRole("img", { name: "出错" })).toBeVisible();
    await expect.element(rows.nth(0).getByRole("img", { name: "运行中" })).not.toBeInTheDocument();
    await expect.element(rows.nth(1).getByRole("img", { name: "待授权" })).toBeVisible();
    await expect.element(rows.nth(2).getByRole("img", { name: "待回答" })).not.toBeInTheDocument();
    const tabs = screen.getByRole("tab");
    await expect.element(tabs.nth(0).getByRole("img", { name: "出错" })).toBeVisible();
    await expect.element(tabs.nth(1).getByRole("img", { name: "运行中" })).toBeVisible();
    onTestFinished(() => localStorage.removeItem("atrium.collapsedProjects"));
    await screen.getByTestId("project-row").click();
    await expect.element(screen.getByTestId("project-row").getByRole("img", { name: "待授权" })).toBeVisible();
  });

  it("collects the sessions that need the user in a card over 设置, folded at first, three when opened, opening one when clicked", async () => {
    onTestFinished(() => localStorage.removeItem("atrium.inboxOpen"));
    const { screen, calls } = await workbench({ initial: needing() });
    // As tall as the window, as in the app, so the card sits at the bottom.
    screen.container.style.height = "820px";

    const inbox = screen.getByRole("region", { name: "等你处理" });
    await expect.element(inbox).toBeVisible();
    // Under the scrolling projects and chats, right over 设置.
    expect(inbox.element().previousElementSibling?.contains(screen.getByTestId("project-row").element())).toBe(true);
    expect(inbox.element().nextElementSibling?.contains(screen.getByRole("button", { name: "设置" }).element())).toBe(
      true,
    );
    const heading = inbox.getByRole("button", { name: /^等你处理/ });
    await expect.element(heading).toHaveAttribute("aria-expanded", "false");
    expect(heading.element().textContent).toBe("等你处理6");
    expect(
      [...heading.element().querySelectorAll("[role=img]")].map((icon) => icon.getAttribute("aria-label")),
    ).toStrictEqual(["待回答", "待授权", "出错"]);
    const rows = inbox.getByTestId("inbox-row");
    expect(rows.elements()).toHaveLength(0);
    const headingTop = heading.element().getBoundingClientRect().top;

    await heading.click();
    await expect.element(heading).toHaveAttribute("aria-expanded", "true");
    // It opens upwards, the heading staying put under the list.
    expect(heading.element().getBoundingClientRect().top).toBe(headingTop);
    expect(inbox.element().lastElementChild).toBe(heading.element());
    expect(localStorage.getItem("atrium.inboxOpen")).toBe("true");
    expect(heading.element().querySelectorAll("[role=img]")).toHaveLength(0);
    expect(rows.elements().map((row) => row.textContent)).toStrictEqual([
      "问一atrium · feat/sidebar12 分钟前",
      expect.stringMatching(/^钥一对话 · 解释 merge-tree/),
      "错二atrium · main3 分钟前",
    ]);
    await expect.element(rows.nth(0).getByRole("img", { name: "待回答" })).toBeVisible();
    await expect.element(rows.nth(1).getByRole("img", { name: "待授权" })).toBeVisible();
    await inbox.getByRole("button", { name: "还有 3 条" }).click();
    expect(rows.elements().map((row) => row.textContent?.slice(0, 2))).toStrictEqual([
      "问一",
      "钥一",
      "错二",
      "错一",
      "错四",
      "错三",
    ]);
    expect(heading.element().getBoundingClientRect().top).toBe(headingTop);
    await expect.element(rows.nth(5)).toHaveTextContent("错三对话 · 解释 merge-tree50 分钟前");
    await inbox.getByRole("button", { name: "收起" }).click();
    await expect.element(rows.nth(3)).not.toBeInTheDocument();

    // A question stays until answered; an error would leave once seen.
    await rows.nth(0).click();
    await vi.waitFor(() => expect(calls).toContain("openSession a1"));
    await expect.element(rows.nth(0)).toHaveAttribute("aria-current", "true");
    await expect.element(rows.nth(1)).toHaveAttribute("aria-current", "false");

    await heading.click();
    await expect.element(heading).toHaveAttribute("aria-expanded", "false");
    await expect.element(rows.nth(0)).not.toBeInTheDocument();
    expect(localStorage.getItem("atrium.inboxOpen")).toBe("false");
  });

  it("unfolds the inbox's list upwards in 0.28 s, the rows one after another, and folds it away, the chevron turning", async () => {
    onTestFinished(() => localStorage.removeItem("atrium.inboxOpen"));
    const { screen } = await workbench({ initial: needing() });
    const inbox = screen.getByRole("region", { name: "等你处理" });
    const heading = inbox.getByRole("button", { name: /^等你处理/ });
    const chevron = heading.element().querySelector(".atrium-fold-chevron") as Element;
    expect(getComputedStyle(chevron).rotate).toBe("none");

    await heading.click();

    const unfolding = screen.getByTestId("inbox-list").element();
    expect([unfolding.getAttribute("data-fold"), heightFrames(unfolding)[0]]).toStrictEqual(["opening", "0px"]);
    expect(foldTimings(unfolding)).toStrictEqual([
      [280, 0],
      [260, 40],
      [260, 54],
      [260, 68],
      [260, 82],
    ]);
    expect(
      chevron
        .getAnimations()
        .map((turn) => [(turn as CSSTransition).transitionProperty, turn.effect?.getTiming().duration]),
    ).toStrictEqual([["rotate", 300]]);
    for (const turn of chevron.getAnimations()) turn.finish();
    expect(getComputedStyle(chevron).rotate).toBe("180deg");
    await expect.element(screen.getByTestId("inbox-list")).toHaveAttribute("data-fold", "open");
    await heading.click();

    const folding = screen.getByTestId("inbox-list").element();
    expect(folding.getAttribute("data-fold")).toBe("closing");
    expect(foldTimings(folding)).toStrictEqual([
      [280, 40],
      [220, 42],
      [220, 28],
      [220, 14],
      [220, 0],
    ]);
    await expect.element(screen.getByTestId("inbox-list")).not.toBeInTheDocument();
  });

  it("unfolds the inbox's list only to the 228px it scrolls beyond", async () => {
    onTestFinished(() => localStorage.removeItem("atrium.inboxOpen"));
    const { screen } = await workbench({ initial: needing() });
    const inbox = screen.getByRole("region", { name: "等你处理" });
    const heading = inbox.getByRole("button", { name: /^等你处理/ });
    await heading.click();
    await inbox.getByRole("button", { name: "还有 3 条" }).click();
    await heading.click();
    await expect.element(screen.getByTestId("inbox-list")).not.toBeInTheDocument();

    await heading.click();

    const unfolding = screen.getByTestId("inbox-list").element();
    expect(unfolding.scrollHeight).toBeGreaterThan(228);
    expect(heightFrames(unfolding)).toStrictEqual(["0px", "228px"]);
  });

  it("opens the inbox's card as it was left", async () => {
    localStorage.setItem("atrium.inboxOpen", "true");
    onTestFinished(() => localStorage.removeItem("atrium.inboxOpen"));
    const { screen } = await workbench({ initial: needing() });
    const inbox = screen.getByRole("region", { name: "等你处理" });

    await expect.element(inbox.getByRole("button", { name: /^等你处理/ })).toHaveAttribute("aria-expanded", "true");
    expect(inbox.getByTestId("inbox-row").elements()).toHaveLength(3);
  });

  it("leaves the inbox out when switched off in the settings, the statuses still showing elsewhere", async () => {
    const { screen, client } = await workbench({ initial: needing() });
    await expect.element(screen.getByRole("region", { name: "等你处理" })).toBeVisible();

    await client.setPreferences({ inbox: false });

    await expect.element(screen.getByRole("region", { name: "等你处理" })).not.toBeInTheDocument();
    await expect.element(screen.getByTestId("workspace-row").nth(1).getByRole("img", { name: "待回答" })).toBeVisible();
  });

  it("leaves the inbox out when nothing needs the user", async () => {
    const { screen } = await workbench();

    await expect.element(screen.getByTestId("project-row")).toBeVisible();
    await expect.element(screen.getByRole("region", { name: "等你处理" })).not.toBeInTheDocument();
  });

  it("goes to a workspace when clicked, and collapses a project to a summary it remembers", async () => {
    const { screen, calls } = await workbench();
    onTestFinished(() => localStorage.removeItem("atrium.collapsedProjects"));

    await screen.getByTestId("workspace-row").nth(1).click();
    await vi.waitFor(() => expect(calls).toContain(`selectContainer ${FEATURE}`));
    await screen.getByTestId("project-row").click();

    await expect.element(screen.getByTestId("workspace-row")).not.toBeInTheDocument();
    await expect.element(screen.getByTestId("project-row")).toHaveTextContent("atrium1 待合并");
    await expect.element(screen.getByTestId("project-row").getByRole("img", { name: "运行中" })).toBeVisible();
    await expect.element(screen.getByTestId("project-row")).toHaveAttribute("aria-current", "true");
    expect(localStorage.getItem("atrium.collapsedProjects")).toBe(JSON.stringify([PROJECT.id]));
  });

  it("folds a project's workspaces away in 0.28 s, the rows one after another, and unfolds them from nothing", async () => {
    const { screen } = await workbench();
    onTestFinished(() => localStorage.removeItem("atrium.collapsedProjects"));
    const project = screen.getByTestId("project-row");
    // Still, the fold leaves the rows' menus unclipped; moving, it clips the rows.
    expect(getComputedStyle(screen.getByTestId("project-workspaces").element()).overflow).toBe("visible");

    await project.click();

    const fold = screen.getByTestId("project-workspaces").element();
    expect([fold.getAttribute("data-fold"), getComputedStyle(fold).overflow]).toStrictEqual(["closing", "hidden"]);
    expect(foldTimings(fold)).toStrictEqual([
      [280, 40],
      [220, 28],
      [220, 14],
      [220, 0],
    ]);
    await expect.element(screen.getByTestId("project-workspaces")).not.toBeInTheDocument();
    await project.click();

    const unfolding = screen.getByTestId("project-workspaces").element();
    expect(unfolding.getAttribute("data-fold")).toBe("opening");
    expect(heightFrames(unfolding)[0]).toBe("0px");
    expect(foldTimings(unfolding)).toStrictEqual([
      [280, 0],
      [260, 40],
      [260, 54],
      [260, 68],
    ]);
    await expect.element(screen.getByTestId("project-workspaces")).toHaveAttribute("data-fold", "open");
    expect(getComputedStyle(unfolding).overflow).toBe("visible");
  });

  it("keeps the rows 2px apart and the chats where they were, before, at the end of and after a fold", async () => {
    const { screen } = await workbench();
    onTestFinished(() => localStorage.removeItem("atrium.collapsedProjects"));
    const project = screen.getByTestId("project-row");
    const rows = screen.getByTestId("workspace-row");
    const chats = screen.getByRole("region", { name: "对话" }).element().firstElementChild as Element;

    expect([gap(project.element(), rows.nth(0).element()), gap(rows.nth(2).element(), chats)]).toStrictEqual([2, 6]);
    await project.click();
    const fold = screen.getByTestId("project-workspaces").element();
    holdAtEnd(fold);

    expect(gap(project.element(), chats)).toBe(6);
    for (const animation of fold.getAnimations({ subtree: true })) animation.finish();
    await expect.element(rows).not.toBeInTheDocument();
    expect(gap(project.element(), chats)).toBe(6);
  });

  it("cross-fades the project's folder between closed and open, scaling it, as its colour follows", async () => {
    const { screen } = await workbench();
    onTestFinished(() => localStorage.removeItem("atrium.collapsedProjects"));
    const row = screen.getByTestId("project-row").element();

    expect(folderIcons(row)).toStrictEqual([
      ["closed", "0", "0.6", []],
      ["open", "1", "none", []],
    ]);
    await screen.getByTestId("project-row").click();

    const moving = [
      ["opacity", 300],
      ["scale", 300],
    ];
    expect(folderIcons(row).map((icon) => icon[3])).toStrictEqual([moving, moving]);
    expect(
      row
        .querySelector(".atrium-folder")
        ?.getAnimations()
        .map((animation) => (animation as CSSTransition).transitionProperty),
    ).toStrictEqual(["color"]);
    for (const transition of row.getAnimations({ subtree: true }).filter((one) => one instanceof CSSTransition)) {
      transition.finish();
    }
    expect(folderIcons(row)).toStrictEqual([
      ["closed", "1", "none", []],
      ["open", "0", "0.6", []],
    ]);
  });

  it("adds the folder the user picks as a project, and nothing when cancelled", async () => {
    const { screen, calls } = await workbench({ picked: "/work/web" });

    await screen.getByRole("button", { name: "添加项目" }).click();

    await vi.waitFor(() => expect(calls).toContain("addProject /work/web"));
  });

  it("explains a folder that is a project already", async () => {
    const { screen } = await workbench({
      picked: "/work/atrium",
      answers: {
        addProject: () => Promise.reject(new CommandError("project_exists", { projectId: PROJECT.id })),
      },
    });

    await screen.getByRole("button", { name: "添加项目" }).click();

    await expect.element(screen.getByRole("alert")).toHaveTextContent("这个目录已经在项目「atrium」里了");
  });

  it("searches workspaces and sessions, and opens what is chosen", async () => {
    const { screen, calls } = await workbench();
    await screen.getByRole("button", { name: "搜索工作区、对话和会话" }).click();

    await userEvent.type(screen.getByRole("textbox", { name: "搜索工作区、对话和会话" }), "SideBar");
    const results = screen.getByRole("region", { name: "搜索结果" });
    await expect
      .element(results)
      .toMatchTextContent(/^工作区feat\/sidebaratrium3未提交会话实现 sidebaratrium · feat\/sidebar1 分钟前$/);
    await results.getByRole("button", { name: /实现 sidebar/ }).click();
    await vi.waitFor(() => expect(calls).toContain("openSession s3"));

    // Results stay after one is chosen; Escape in the box closes the search.
    await screen.getByRole("textbox", { name: "搜索工作区、对话和会话" }).click();
    await userEvent.keyboard("{Escape}");
    await expect.element(screen.getByRole("region", { name: "搜索结果" })).not.toBeInTheDocument();
  });

  it("finds chats by name in a group of their own, going to one when chosen", async () => {
    const initial = list();
    const { screen, calls } = await workbench({
      initial: { ...initial, chats: [chat({ id: CHAT, firstSessionId: "c1", alias: "Merge 原理" })] },
    });
    await screen.getByRole("button", { name: "搜索工作区、对话和会话" }).click();
    const box = screen.getByRole("textbox", { name: "搜索工作区、对话和会话" });

    await userEvent.type(box, "MERGE");
    const results = screen.getByRole("region", { name: "搜索结果" });
    await expect
      .element(results)
      .toMatchTextContent(/^对话Merge 原理1 分钟前会话解释 merge-tree对话 · Merge 原理1 分钟前$/);
    await userEvent.fill(box, "原理");
    await expect.element(results).toMatchTextContent(/^对话Merge 原理1 分钟前$/);
    await results.getByRole("button").click();

    await vi.waitFor(() => expect(calls).toContain("openSession c1"));
  });

  it("says when nothing matches", async () => {
    const { screen } = await workbench();
    await screen.getByRole("button", { name: "搜索工作区、对话和会话" }).click();

    await userEvent.type(screen.getByRole("textbox", { name: "搜索工作区、对话和会话" }), "nothing");

    await expect.element(screen.getByText("没有匹配的工作区、对话或会话")).toBeVisible();
  });

  it("lists chats like workspaces, latest first, five until the rest are shown in place", async () => {
    const minute = 60_000;
    const sessions = Array.from({ length: 7 }, (_, at) =>
      session({
        sessionId: `c${at}`,
        containerId: `cht_${at}`,
        prompt: `问题 ${at}`,
        updatedAt: Date.now() - (at + 1) * minute,
      }),
    );
    const { screen, calls } = await workbench({
      initial: {
        ...list(),
        sessions: [
          ...sessions,
          // A later session of chat 6 brings it to the top, with its status; its name stays the first's.
          session({ sessionId: "c6b", containerId: "cht_6", prompt: "追问", running: true, updatedAt: Date.now() }),
          session({ sessionId: "gone", containerId: "cht_gone", archived: true }),
        ],
        chats: [
          ...sessions.map((one, at) => chat({ id: `cht_${at}`, firstSessionId: one.sessionId })),
          chat({ id: "cht_gone", firstSessionId: null }),
        ],
      },
    });
    const section = screen.getByRole("region", { name: "对话" });
    const rows = section.getByTestId("chat-row");

    await expect.element(rows.nth(0)).toHaveTextContent("问题 6刚刚");
    await expect.element(rows.nth(0).getByRole("img", { name: "运行中" })).toBeVisible();
    expect(rows.elements().map((row) => row.textContent)).toStrictEqual([
      "问题 6刚刚",
      "问题 01 分钟前",
      "问题 12 分钟前",
      "问题 23 分钟前",
      "问题 34 分钟前",
    ]);
    await section.getByRole("button", { name: "显示全部 7 个" }).click();
    await expect.element(rows.nth(6)).toHaveTextContent("问题 56 分钟前");
    await section.getByRole("button", { name: "收起" }).click();
    await expect.element(rows.nth(5)).not.toBeInTheDocument();
    // The area opens the active session s1 of the local workspace on its own.
    expect(calls.filter((call) => /^(selectContainer|openSession c)/.test(call))).toStrictEqual([]);
  });

  it("starts a chat from the icon on 对话's heading, shown with no chats too, and from nowhere else in the sidebar", async () => {
    const { screen, calls } = await workbench({ initial: { ...list(), chats: [] } });
    const section = screen.getByRole("region", { name: "对话" });

    expect(section.element().textContent).toBe("对话");
    expect(
      screen
        .getByRole("navigation", { name: "侧栏" })
        .getByRole("button", { name: /新建对话/ })
        .elements(),
    ).toHaveLength(1);
    const button = section.getByRole("button", { name: "新建对话", exact: true });
    await expect.element(button).toHaveAttribute("title", "新建对话（⌘N）");
    // On the heading's line, as 项目's buttons are.
    expect(button.element().parentElement?.textContent).toBe("对话");
    await button.click();

    await vi.waitFor(() => expect(calls).toContain("createChat"));
  });

  it("puts the chats' rows right under the heading", async () => {
    const { screen } = await workbench();
    const section = screen.getByRole("region", { name: "对话" });

    await expect.element(section.getByTestId("chat-row")).toBeVisible();
    expect(section.element().textContent).toMatch(/^对话解释 merge-tree/);
  });

  it("names a chat by its alias, else its first session's title, else as new", async () => {
    const initial = list();
    await workbench({
      initial: {
        ...initial,
        sessions: [
          ...initial.sessions,
          session({ sessionId: "d1", containerId: "cht_b", prompt: null, file: null, state: "draft" }),
          session({ sessionId: "r1", containerId: "cht_c", prompt: "周报的提纲" }),
        ],
        chats: [
          ...initial.chats,
          chat({ id: "cht_b", firstSessionId: "d1" }),
          chat({ id: "cht_c", firstSessionId: "r1", alias: "周报" }),
        ],
      },
    });

    const rows = page.getByRole("region", { name: "对话" }).getByTestId("chat-row");
    await expect
      .poll(() => rows.elements().map((row) => row.querySelector(".truncate")?.textContent))
      .toStrictEqual(["解释 merge-tree", "新对话", "周报"]);
  });

  it("opens a chat's latest session when it has no tab open, and goes back to its tabs when it has", async () => {
    const initial = list();
    const { screen, calls, index } = await workbench({
      initial: {
        ...initial,
        sessions: [
          ...initial.sessions,
          session({ sessionId: "c2", containerId: CHAT, prompt: "再问", updatedAt: Date.now() - 1000 }),
          session({ sessionId: "b1", containerId: "cht_b", prompt: "旧的", updatedAt: Date.now() - 9000 }),
          session({ sessionId: "b2", containerId: "cht_b", prompt: "新的", updatedAt: Date.now() - 2000 }),
        ],
        chats: [...initial.chats, chat({ id: "cht_b", firstSessionId: "b1" })],
        layout: { ...initial.layout, tabs: { ...initial.layout.tabs, [CHAT]: { open: ["c1"], active: "c1" } } },
      },
    });
    const rows = screen.getByRole("region", { name: "对话" }).getByTestId("chat-row");
    await expect.element(rows.nth(1)).toHaveTextContent("旧的刚刚");

    await rows.nth(1).click();
    await vi.waitFor(() => expect(calls).toContain("openSession b2"));
    await expect.element(rows.nth(1)).toHaveAttribute("aria-current", "true");
    await expect.element(rows.nth(0)).toHaveAttribute("aria-current", "false");
    await rows.nth(0).click();

    await vi.waitFor(() => expect(calls).toContain(`selectContainer ${CHAT}`));
    await expect.element(rows.nth(0)).toHaveAttribute("aria-current", "true");
    expect(calls).not.toContain("openSession c2");
    expect(index.getState().layout.tabs[CHAT]).toStrictEqual({ open: ["c1"], active: "c1" });
  });

  it("explains a chat that went while it was being renamed", async () => {
    const { screen } = await workbench({
      answers: { renameChat: () => Promise.reject(new CommandError("chat_not_found", { chatId: CHAT })) },
    });
    const row = screen.getByRole("region", { name: "对话" }).getByTestId("chat-row");
    await row.hover();
    await row.getByRole("button", { name: "对话 解释 merge-tree" }).click();
    await screen.getByRole("menuitem", { name: "重命名" }).click();

    await userEvent.fill(screen.getByRole("textbox", { name: "对话名称" }), "合并原理");
    await userEvent.keyboard("{Enter}");

    await expect.element(screen.getByRole("alert")).toHaveTextContent("这个对话已经不在了");
  });

  it("renames a chat in place from its menu, and clears its name with an empty one", async () => {
    const initial = list();
    const { screen, calls } = await workbench({
      initial: { ...initial, chats: [chat({ id: CHAT, firstSessionId: "c1", alias: "合并原理" })] },
    });
    const row = screen.getByRole("region", { name: "对话" }).getByTestId("chat-row");
    await row.hover();
    await row.getByRole("button", { name: "对话 合并原理" }).click();
    await screen.getByRole("menuitem", { name: "重命名" }).click();

    await userEvent.fill(screen.getByRole("textbox", { name: "对话名称" }), "merge-tree");
    await userEvent.keyboard("{Enter}");
    await vi.waitFor(() => expect(calls).toContain(`renameChat ${CHAT} merge-tree`));
    await row.hover();
    await row.getByRole("button", { name: "对话 合并原理" }).click();
    await screen.getByRole("menuitem", { name: "重命名" }).click();
    await userEvent.clear(screen.getByRole("textbox", { name: "对话名称" }));
    await userEvent.keyboard("{Enter}");

    await vi.waitFor(() => expect(calls).toContain(`renameChat ${CHAT} null`));
    // The area opens the active session s1 of the local workspace on its own.
    expect(calls.filter((call) => /^(selectContainer|openSession c)/.test(call))).toStrictEqual([]);
  });

  it("renames a workspace in place, and clears its name with an empty one", async () => {
    const { screen, calls } = await workbench();
    const row = screen.getByTestId("workspace-row").nth(1);
    await row.hover();
    await row.getByRole("button", { name: "工作区 feat/sidebar" }).click();
    await screen.getByRole("menuitem", { name: "重命名" }).click();

    await userEvent.fill(screen.getByRole("textbox", { name: "工作区名称" }), "侧栏");
    await userEvent.keyboard("{Enter}");
    await vi.waitFor(() => expect(calls).toContain(`renameWorkspace ${FEATURE} 侧栏`));
    expect(calls).not.toContain(`selectContainer ${FEATURE}`);
  });

  it("renames and removes a project from its menu", async () => {
    const { screen, calls } = await workbench();
    const project = screen.getByTestId("project-row");
    await project.hover();
    await project.getByRole("button", { name: "项目 atrium" }).click();
    await screen.getByRole("menuitem", { name: "从侧栏移除" }).click();

    await vi.waitFor(() => expect(calls).toContain(`removeProject ${PROJECT.id}`));
  });

  it("switches the appearance between following the system, light and dark", async () => {
    const { screen, calls, native } = await workbench();
    onTestFinished(() => document.documentElement.classList.remove("dark"));

    await screen.getByRole("button", { name: "外观：跟随系统" }).click();
    await screen.getByRole("button", { name: "外观：浅色" }).click();

    await expect.element(screen.getByRole("button", { name: "外观：深色" })).toBeVisible();
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(native).toStrictEqual(["system", "light", "dark"]);
    expect(calls.filter((call) => call.startsWith("setPreferences"))).toStrictEqual([
      'setPreferences {"appearance":"light"}',
      'setPreferences {"appearance":"dark"}',
    ]);
  });

  it("paints the sidebar in DeepSeek Harness's colours when light, see-through when dark", async () => {
    const { screen } = await workbench();
    onTestFinished(() => document.documentElement.classList.remove("dark"));
    const sidebar = screen.getByRole("navigation", { name: "侧栏" }).element();

    expect(getComputedStyle(sidebar).backgroundImage).toBe(
      "linear-gradient(rgb(213, 219, 233) 0%, rgb(218, 224, 233) 10%, rgb(225, 228, 234) 25%, rgb(227, 231, 233) 35%, rgb(227, 231, 233) 65%, rgb(226, 228, 230) 75%, rgb(222, 225, 231) 85%, rgb(216, 219, 227) 100%)",
    );
    document.documentElement.classList.add("dark");

    expect([getComputedStyle(sidebar).backgroundImage, getComputedStyle(sidebar).backgroundColor]).toStrictEqual([
      "none",
      "rgba(95, 102, 114, 0.42)",
    ]);
  });

  it("lets the window's material through the sidebar in the desktop app, light and dark", async () => {
    const { screen } = await workbench();
    onTestFinished(() => {
      document.documentElement.classList.remove("dark");
      delete document.documentElement.dataset["material"];
    });
    const sidebar = screen.getByRole("navigation", { name: "侧栏" }).element();
    const main = screen.getByRole("main").element();
    document.documentElement.dataset["material"] = "";
    const painted = () => [
      getComputedStyle(document.body).backgroundColor,
      getComputedStyle(sidebar).backgroundImage,
      getComputedStyle(sidebar).backgroundColor,
      getComputedStyle(main).backgroundColor,
    ];

    expect(painted()).toStrictEqual(["rgba(0, 0, 0, 0)", "none", "rgba(0, 0, 0, 0)", "rgb(255, 255, 255)"]);
    document.documentElement.classList.add("dark");
    expect(painted()).toStrictEqual(["rgba(0, 0, 0, 0)", "none", "rgba(0, 0, 0, 0)", "rgb(21, 21, 23)"]);
  });
});

/**
 * How an element's changes are animated: the properties, their durations and their curves.
 *
 * @sideEffects none
 * @param element - The element.
 * @returns The three, as computed.
 */
function motion(element: Element): string[] {
  const style = getComputedStyle(element);
  return [style.transitionProperty, style.transitionDuration, style.transitionTimingFunction];
}

/**
 * Where an element is in the window, and how wide.
 *
 * @sideEffects none
 * @param element - The element.
 * @returns Its left, top and width in pixels.
 */
function placed(element: Element): number[] {
  const rect = element.getBoundingClientRect();
  return [rect.left, rect.top, rect.width];
}

const PANE_CURVE = "cubic-bezier(0.2, 0.8, 0.2, 1)";

/**
 * Whether a press at an element's middle would drag the window, by Electron's rule.
 *
 * @remarks
 * Electron lays the page's `-webkit-app-region` areas over one another in page order, each
 * `drag` adding and each `no-drag` taking away, so the last that covers a point decides it. A
 * browser has no such regions, so a click there tells nothing.
 *
 * @sideEffects none
 * @param element - The element.
 * @returns `true` if the window would take the press as a drag.
 */
function dragsWindowAt(element: Element): boolean {
  const rect = element.getBoundingClientRect();
  const [x, y] = [rect.left + rect.width / 2, rect.top + rect.height / 2];
  const regions = [...document.querySelectorAll("*")]
    .map(
      (each) => [getComputedStyle(each).getPropertyValue("-webkit-app-region"), each.getBoundingClientRect()] as const,
    )
    .filter(([region, at]) => region !== "none" && at.left <= x && x < at.right && at.top <= y && y < at.bottom);
  return regions.at(-1)?.[0] === "drag";
}

describe("Workbench panes", () => {
  it("keeps its sidebar toggle pressable over the window's drag areas, folded or not", async () => {
    const { screen } = await workbench();
    onTestFinished(() => localStorage.removeItem("atrium.sidebarCollapsed"));
    const toggle = screen.getByRole("button", { name: "折叠侧栏" });
    const pressable = [dragsWindowAt(toggle.element())];

    await toggle.click();
    const unfold = screen.getByRole("button", { name: "展开侧栏" });
    await expect.poll(() => placed(unfold.element())).toStrictEqual([84, 10, 28]);
    pressable.push(dragsWindowAt(unfold.element()));

    expect(pressable).toStrictEqual([false, false]);
  });

  it("folds the sidebar away from its toggle and ⌘B, the toggle moving beside the traffic lights and the tabs making room, and remembers it", async () => {
    const { screen } = await workbench();
    onTestFinished(() => localStorage.removeItem("atrium.sidebarCollapsed"));
    const nav = screen.getByRole("navigation", { name: "侧栏" }).element();
    const inside = screen.getByTestId("sidebar-inside").element();
    const bar = screen.getByTestId("tab-bar").element();
    const toggle = screen.getByRole("button", { name: "折叠侧栏" });

    expect([placed(toggle.element()), placed(nav)[2], getComputedStyle(bar).paddingLeft]).toStrictEqual([
      [226, 10, 28],
      270,
      "12px",
    ]);
    expect([toggle.element().getAttribute("title"), toggle.element().getAttribute("aria-expanded")]).toStrictEqual([
      "折叠侧栏（⌘B）",
      "true",
    ]);
    expect([motion(nav), motion(inside), motion(toggle.element()), motion(bar)]).toStrictEqual([
      ["width", "0.24s", PANE_CURVE],
      ["opacity, translate", "0.2s, 0.24s", `ease, ${PANE_CURVE}`],
      ["left", "0.24s", PANE_CURVE],
      ["padding-left", "0.24s", PANE_CURVE],
    ]);
    await toggle.click();

    await expect.poll(() => placed(nav)[2]).toBe(0);
    const unfold = screen.getByRole("button", { name: "展开侧栏" });
    await expect.poll(() => placed(unfold.element())).toStrictEqual([84, 10, 28]);
    await expect.poll(() => getComputedStyle(bar).paddingLeft).toBe("120px");
    await expect
      .poll(() => [getComputedStyle(inside).opacity, getComputedStyle(inside).translate])
      .toStrictEqual(["0", "-24px"]);
    expect([
      (nav as HTMLElement).inert,
      unfold.element().getAttribute("title"),
      unfold.element().getAttribute("aria-expanded"),
      localStorage.getItem("atrium.sidebarCollapsed"),
    ]).toStrictEqual([true, "展开侧栏（⌘B）", "false", "true"]);
    await userEvent.keyboard("{Meta>}b{/Meta}");

    await expect.poll(() => placed(nav)[2]).toBe(270);
    await expect.poll(() => placed(toggle.element())).toStrictEqual([226, 10, 28]);
    expect([(nav as HTMLElement).inert, localStorage.getItem("atrium.sidebarCollapsed")]).toStrictEqual([
      false,
      "false",
    ]);
  });

  it("starts as left: the sidebar folded, the changes panel open and as wide as it was", async () => {
    localStorage.setItem("atrium.sidebarCollapsed", "true");
    localStorage.setItem("atrium.changesOpen", "true");
    localStorage.setItem("atrium.changesWidth", "420");
    onTestFinished(() => {
      for (const key of ["atrium.sidebarCollapsed", "atrium.changesOpen", "atrium.changesWidth"]) {
        localStorage.removeItem(key);
      }
    });
    const { screen } = await workbench();

    await expect.element(screen.getByRole("complementary", { name: "改动" })).toBeVisible();
    expect([
      placed(screen.getByRole("navigation", { name: "侧栏" }).element())[2],
      placed(screen.getByRole("button", { name: "展开侧栏" }).element()),
      placed(screen.getByTestId("changes-pane").element())[2],
      screen.getByRole("button", { name: "改动面板" }).element().getAttribute("aria-pressed"),
    ]).toStrictEqual([0, [84, 10, 28], 420, "true"]);
  });

  it("opens and closes the changes panel from the tab bar's last button and ⌥⌘B, open in every workspace, hidden in a chat", async () => {
    const { screen, changeCalls } = await workbench();
    onTestFinished(() => localStorage.removeItem("atrium.changesOpen"));
    const toggle = screen.getByRole("button", { name: "改动面板" });
    const panel = screen.getByRole("complementary", { name: "改动" });
    const said = () => [
      toggle.element().getAttribute("aria-pressed"),
      toggle.element().getAttribute("aria-disabled"),
      toggle.element().getAttribute("title"),
      localStorage.getItem("atrium.changesOpen"),
    ];

    expect(said()).toStrictEqual(["false", "false", "改动面板（⌥⌘B）", null]);
    expect([...screen.getByTestId("tab-bar").element().querySelectorAll("button")].at(-1)).toBe(toggle.element());
    await toggle.click();
    await expect.element(panel).toBeVisible();
    expect(said()).toStrictEqual(["true", "false", "改动面板（⌥⌘B）", "true"]);
    await screen.getByTestId("workspace-row").nth(1).click();

    await vi.waitFor(() => expect(changeCalls).toContain(`watchDiff ${FEATURE} base`));
    await expect.element(panel).toBeVisible();
    await screen.getByTestId("chat-row").click();

    await expect.element(panel).not.toBeInTheDocument();
    expect(said()).toStrictEqual(["false", "true", "对话没有工作区，没有改动", "true"]);
    await toggle.click({ force: true });
    await userEvent.keyboard("{Meta>}{Alt>}b{/Alt}{/Meta}");
    expect(said()).toStrictEqual(["false", "true", "对话没有工作区，没有改动", "true"]);
    await screen.getByTestId("workspace-row").nth(0).click();

    await expect.element(panel).toBeVisible();
    await userEvent.keyboard("{Meta>}{Alt>}b{/Alt}{/Meta}");
    await expect.element(panel).not.toBeInTheDocument();
    expect(said()).toStrictEqual(["false", "false", "改动面板（⌥⌘B）", "false"]);
    await userEvent.keyboard("{Meta>}{Alt>}b{/Alt}{/Meta}");
    await expect.element(panel).toBeVisible();
  });

  it("leaves the changes panel as it was on ⌥⌘B over the new-workspace page", async () => {
    const { screen } = await workbench();
    onTestFinished(() => localStorage.removeItem("atrium.changesOpen"));
    const project = screen.getByTestId("project-row");
    await project.hover();
    await project.getByRole("button", { name: "在 atrium 新建工作区" }).click();
    await expect.element(screen.getByText("新建工作区", { exact: true })).toBeVisible();

    await userEvent.keyboard("{Meta>}{Alt>}b{/Alt}{/Meta}");

    expect(localStorage.getItem("atrium.changesOpen")).toBeNull();
  });
});

/**
 * The list of {@link list} with the merged worktree running one of its two live sessions, and two
 * worktrees archived five minutes and two hours ago.
 *
 * @sideEffects none
 * @returns The list.
 */
function archivable() {
  const base = list();
  return {
    ...base,
    workspaces: [
      ...base.workspaces,
      workspace({ id: "wks_00000000000000a1", branch: "old/one", archivedAt: Date.now() - 2 * 60 * 60_000 }),
      workspace({ id: "wks_00000000000000a2", branch: "old/two", archivedAt: Date.now() - 5 * 60_000 }),
    ],
    sessions: [
      ...base.sessions,
      session({ sessionId: "m1", containerId: MERGED, prompt: "收尾", running: true }),
      session({ sessionId: "m2", containerId: MERGED, prompt: "早先的", running: true, archived: true }),
      session({ sessionId: "m3", containerId: MERGED, prompt: "闲着" }),
    ],
  };
}

/**
 * Opens the "···" menu of the n-th workspace row.
 *
 * @sideEffects Hovers and clicks in the page.
 * @param screen - The rendered workbench.
 * @param nth - Which row, from 0.
 * @param name - The workspace's name.
 */
async function workspaceMenu(screen: Awaited<ReturnType<typeof workbench>>["screen"], nth: number, name: string) {
  const row = screen.getByTestId("workspace-row").nth(nth);
  await row.hover();
  await row.getByRole("button", { name: `工作区 ${name}` }).click();
}

/**
 * Archives the n-th workspace row with the button its hover shows.
 *
 * @sideEffects Hovers and clicks in the page.
 * @param screen - The rendered workbench.
 * @param nth - Which row, from 0.
 * @param name - The workspace's name.
 */
async function archiveWorkspaceRow(screen: Awaited<ReturnType<typeof workbench>>["screen"], nth: number, name: string) {
  const row = screen.getByTestId("workspace-row").nth(nth);
  await row.hover();
  await row.getByRole("button", { name: `归档工作区 ${name}` }).click();
}

/**
 * Opens the project's "···" menu.
 *
 * @sideEffects Hovers and clicks in the page.
 * @param screen - The rendered workbench.
 */
async function projectMenu(screen: Awaited<ReturnType<typeof workbench>>["screen"]) {
  const project = screen.getByTestId("project-row");
  await project.hover();
  await project.getByRole("button", { name: "项目 atrium" }).click();
}

describe("Workbench workspace archiving (M1.11)", () => {
  it("asks before archiving a worktree, saying its branch is kept and its running sessions stop, then hides it", async () => {
    const { screen, calls } = await workbench({ initial: archivable() });
    await archiveWorkspaceRow(screen, 2, "fix/typo");

    const dialog = screen.getByRole("alertdialog", { name: "归档工作区「fix/typo」？" });
    await expect
      .element(dialog)
      .toHaveAccessibleDescription(
        "会删除 worktree 目录（包括被 git 忽略的文件），分支 fix/typo 保留；之后可以在项目菜单的“已归档的工作区”里恢复 其中 1 个会话正在运行，归档会停止它们",
      );
    await expect.element(dialog.getByRole("button", { name: "取消" })).toHaveFocus();
    // On the page's body, so it covers the whole window rather than the sidebar.
    expect(dialog.element().closest("nav")).toBeNull();
    expect(calls).not.toContain(`archiveWorkspace ${MERGED}`);

    await dialog.getByRole("button", { name: "归档" }).click();

    await expect.element(dialog).not.toBeInTheDocument();
    expect(calls).toContain(`archiveWorkspace ${MERGED}`);
    expect(calls).not.toContain(`selectContainer ${MERGED}`);
    await vi.waitFor(() => expect(screen.getByTestId("workspace-row").elements()).toHaveLength(2));
    await expect.element(screen.getByTestId("workspace-row").nth(1)).toHaveTextContent("feat/sidebar3未提交");
  });

  it("says a detached worktree's commit is kept, and warns of nothing when none of its sessions runs", async () => {
    const base = list();
    const { screen } = await workbench({
      initial: {
        ...base,
        workspaces: [...base.workspaces, workspace({ id: "wks_00000000000000d1", branch: null, head: "abc1234" })],
      },
    });
    await archiveWorkspaceRow(screen, 2, "wks_00000000000000d1");

    await expect
      .element(screen.getByRole("alertdialog"))
      .toHaveAccessibleDescription(
        "会删除 worktree 目录（包括被 git 忽略的文件），提交 abc1234 保留；之后可以在项目菜单的“已归档的工作区”里恢复",
      );
  });

  it("says nothing is kept when the worktree was on neither a branch nor a commit", async () => {
    const base = list();
    const { screen } = await workbench({
      initial: {
        ...base,
        workspaces: [...base.workspaces, workspace({ id: "wks_00000000000000d2", branch: null, head: null })],
      },
    });
    await archiveWorkspaceRow(screen, 2, "wks_00000000000000d2");

    await expect
      .element(screen.getByRole("alertdialog"))
      .toHaveAccessibleDescription(
        "会删除 worktree 目录（包括被 git 忽略的文件）；之后可以在项目菜单的“已归档的工作区”里恢复",
      );
  });

  it("offers archiving only for a worktree, on hover left of its menu, faded and saying why while it has changes not committed", async () => {
    const { screen, calls } = await workbench();
    const rows = screen.getByTestId("workspace-row");

    await rows.nth(0).hover();
    await expect.element(rows.nth(0).getByRole("button", { name: "工作区 main" })).toBeVisible();
    expect(
      rows
        .nth(0)
        .getByRole("button", { name: /^归档/ })
        .elements(),
    ).toHaveLength(0);
    await workspaceMenu(screen, 0, "main");
    expect(
      screen
        .getByRole("menuitem")
        .elements()
        .map((item) => item.textContent),
    ).toStrictEqual(["重命名"]);
    await userEvent.keyboard("{Escape}");

    await rows.nth(1).hover();
    const dirty = rows.nth(1).getByRole("button", { name: "归档工作区 feat/sidebar" });
    await expect.element(dirty).toHaveAttribute("aria-disabled", "true");
    await expect.element(dirty).toHaveAttribute("title", "有未提交的改动，先提交或丢弃");
    await dirty.click({ force: true });
    await expect.element(screen.getByRole("alertdialog")).not.toBeInTheDocument();

    await rows.nth(2).hover();
    const archive = rows.nth(2).getByRole("button", { name: "归档工作区 fix/typo" });
    await expect.element(archive).toHaveAttribute("aria-disabled", "false");
    await expect.element(archive).toHaveAttribute("title", "归档");
    // A red trash can on a faint red, so it reads as taking something away.
    expect([
      getComputedStyle(archive.element()).color,
      getComputedStyle(archive.element()).backgroundColor,
    ]).toStrictEqual([computedColor("var(--danger)"), computedColor("var(--danger-soft)")]);
    expect(
      archive
        .element()
        .nextElementSibling?.contains(rows.nth(2).getByRole("button", { name: "工作区 fix/typo" }).element()),
    ).toBe(true);
    expect(gapAfter(archive.element())).toBe(4);
    expect(calls).not.toContain(`selectContainer ${FEATURE}`);
  });

  it("cancels with 取消, Escape or a click outside, archiving nothing", async () => {
    const { screen, calls } = await workbench();
    const dialog = screen.getByRole("alertdialog");
    const ways = [
      () => dialog.getByRole("button", { name: "取消" }).click(),
      () => userEvent.keyboard("{Escape}"),
      () => screen.getByTestId("archive-scrim").click({ position: { x: 5, y: 5 } }),
    ];
    for (const cancel of ways) {
      await archiveWorkspaceRow(screen, 2, "fix/typo");
      await expect.element(dialog).toBeVisible();
      await cancel();
      await expect.element(dialog).not.toBeInTheDocument();
    }

    expect(calls.filter((call) => call.startsWith("archiveWorkspace"))).toStrictEqual([]);
    await vi.waitFor(() => expect(screen.getByTestId("workspace-row").elements()).toHaveLength(3));
  });

  it("waits while archiving, then says why it failed and lets the user try again", async () => {
    const answer = Promise.withResolvers<void>();
    const { screen, calls } = await workbench({ answers: { archiveWorkspace: () => answer.promise } });
    await archiveWorkspaceRow(screen, 2, "fix/typo");
    const dialog = screen.getByRole("alertdialog");
    await dialog.getByRole("button", { name: "归档" }).click();

    await expect.element(dialog.getByRole("button", { name: "归档中…" })).toBeDisabled();
    await expect.element(dialog.getByRole("button", { name: "取消" })).toBeDisabled();
    await userEvent.keyboard("{Escape}");
    await screen.getByTestId("archive-scrim").click({ position: { x: 5, y: 5 }, force: true });
    await expect.element(dialog).toBeVisible();

    answer.reject(new CommandError("workspace_dirty"));

    await expect.element(dialog.getByRole("alert")).toHaveTextContent("有未提交的改动，先提交或丢弃再归档");
    await expect.element(dialog.getByRole("button", { name: "归档" })).toBeEnabled();
    expect(calls.filter((call) => call.startsWith("archiveWorkspace"))).toStrictEqual([`archiveWorkspace ${MERGED}`]);
    await vi.waitFor(() => expect(screen.getByTestId("workspace-row").elements()).toHaveLength(3));
  });

  it("lays the dialog out as a 380 px card over a blurred scrim, its buttons 30 px tall", async () => {
    const { screen } = await workbench();
    await archiveWorkspaceRow(screen, 2, "fix/typo");
    const dialog = screen.getByRole("alertdialog").element();
    const scrim = screen.getByTestId("archive-scrim").element();

    expect(dialog.getBoundingClientRect().width).toBe(380);
    expect(getComputedStyle(scrim).backdropFilter).toContain("blur(8px)");
    expect([scrim.getBoundingClientRect().width, scrim.getBoundingClientRect().height]).toStrictEqual([1280, 820]);
    expect(
      ["取消", "归档"].map(
        (name) =>
          screen.getByRole("alertdialog").getByRole("button", { name }).element().getBoundingClientRect().height,
      ),
    ).toStrictEqual([30, 30]);
  });

  it("hides archived workspaces from the projects and search, listing them in the project's menu newest first, opened and closed in place", async () => {
    const { screen } = await workbench({ initial: archivable() });

    await vi.waitFor(() => expect(screen.getByTestId("workspace-row").elements()).toHaveLength(3));
    await screen.getByRole("button", { name: "搜索工作区、对话和会话" }).click();
    await userEvent.type(screen.getByRole("textbox", { name: "搜索工作区、对话和会话" }), "old/");
    await expect.element(screen.getByText("没有匹配的工作区、对话或会话")).toBeVisible();
    await userEvent.keyboard("{Escape}");

    await projectMenu(screen);
    await screen.getByRole("menuitem", { name: "已归档的工作区" }).click();

    await expect
      .element(screen.getByRole("list", { name: "已归档的工作区" }))
      .toHaveTextContent("old/two5 分钟前恢复old/one2 小时前恢复");
    await screen.getByRole("menuitem", { name: "已归档的工作区" }).click();
    await expect.element(screen.getByRole("list", { name: "已归档的工作区" })).not.toBeInTheDocument();
    await expect
      .element(screen.getByRole("menuitem", { name: "已归档的工作区" }))
      .toHaveAttribute("aria-expanded", "false");
  });

  it("leaves the archived item out of a project with none archived", async () => {
    const { screen } = await workbench();
    await projectMenu(screen);

    await expect.element(screen.getByRole("menuitem", { name: "从侧栏移除" })).toBeVisible();
    await expect.element(screen.getByRole("menuitem", { name: "已归档的工作区" })).not.toBeInTheDocument();
  });

  it("restores an archived workspace from the list, closing the menu and showing it again", async () => {
    const { screen, calls } = await workbench({ initial: archivable() });
    await projectMenu(screen);
    await screen.getByRole("menuitem", { name: "已归档的工作区" }).click();
    await screen.getByRole("menuitem", { name: "恢复 old/one" }).click();

    await vi.waitFor(() => expect(calls).toContain("restoreWorkspace wks_00000000000000a1"));
    await expect.element(screen.getByRole("menu")).not.toBeInTheDocument();
    await vi.waitFor(() => expect(screen.getByTestId("workspace-row").elements()).toHaveLength(4));
    await expect.element(screen.getByTestId("workspace-row").nth(2)).toHaveTextContent("old/one");
  });

  it("shows eight archived workspaces before the list scrolls", async () => {
    const base = list();
    const { screen } = await workbench({
      initial: {
        ...base,
        workspaces: Array.from({ length: 10 }, (_, n) =>
          workspace({ id: `wks_00000000000000b${n}`, archivedAt: Date.now() - n * 60_000 }),
        ),
      },
    });
    await projectMenu(screen);
    await screen.getByRole("menuitem", { name: "已归档的工作区" }).click();
    const shown = screen.getByRole("list", { name: "已归档的工作区" }).element();

    expect([shown.clientHeight, shown.scrollHeight]).toStrictEqual([256, 320]);
  });

  it("explains a restore that failed", async () => {
    const { screen } = await workbench({
      initial: archivable(),
      answers: { restoreWorkspace: () => Promise.reject(new CommandError("worktree_restore_failed")) },
    });
    await projectMenu(screen);
    await screen.getByRole("menuitem", { name: "已归档的工作区" }).click();
    await screen.getByRole("menuitem", { name: "恢复 old/two" }).click();

    await expect
      .element(screen.getByRole("alert"))
      .toHaveTextContent("没能恢复：git 没能加回这个 worktree，分支可能正被别处检出");
  });
});

describe("Workbench sidebar: archived chats", () => {
  it("archives a chat none of whose sessions runs at once, and lists it under 已归档的对话, opened and closed in place", async () => {
    const { screen, calls } = await workbench();
    const section = screen.getByRole("region", { name: "对话" });
    await expect.element(section.getByRole("button", { name: "已归档的对话" })).not.toBeInTheDocument();
    await chatMenu(screen, "解释 merge-tree");
    expect(
      screen
        .getByRole("menuitem")
        .elements()
        .map((item) => item.textContent),
    ).toStrictEqual(["重命名"]);
    await userEvent.keyboard("{Escape}");
    const archive = section.getByRole("button", { name: "归档对话 解释 merge-tree" });
    await expect.element(archive).toHaveAttribute("title", "归档");
    // A red trash can on a faint red, so it reads as taking something away.
    expect([
      getComputedStyle(archive.element()).color,
      getComputedStyle(archive.element()).backgroundColor,
    ]).toStrictEqual([computedColor("var(--danger)"), computedColor("var(--danger-soft)")]);
    expect(
      archive
        .element()
        .nextElementSibling?.contains(section.getByRole("button", { name: "对话 解释 merge-tree" }).element()),
    ).toBe(true);
    expect(gapAfter(archive.element())).toBe(4);

    await archiveChatRow(screen, "解释 merge-tree");

    await vi.waitFor(() => expect(calls).toContain(`archiveChat ${CHAT}`));
    await expect.element(screen.getByRole("alertdialog")).not.toBeInTheDocument();
    await expect.element(section.getByTestId("chat-row")).not.toBeInTheDocument();
    const archived = section.getByRole("button", { name: "已归档的对话" });
    await expect.element(archived).toHaveAttribute("aria-expanded", "false");
    await archived.click();
    await expect
      .element(section.getByRole("list", { name: "已归档的对话" }))
      .toHaveTextContent("解释 merge-tree刚刚恢复");
    await archived.click();
    await expect.element(section.getByRole("list", { name: "已归档的对话" })).not.toBeInTheDocument();
  });

  it("asks first when some of a chat's sessions run, archiving nothing when cancelled", async () => {
    const base = withC1({ running: true });
    const { screen, calls } = await workbench({
      initial: {
        ...base,
        sessions: [...base.sessions, session({ sessionId: "c2", containerId: CHAT, prompt: "追问", running: true })],
      },
    });
    await archiveChatRow(screen, "解释 merge-tree");
    const dialog = screen.getByRole("alertdialog");

    await expect.element(dialog).toHaveAccessibleName("归档对话「解释 merge-tree」？");
    await expect
      .element(dialog)
      .toHaveAccessibleDescription("其中 2 个会话正在运行，归档会停止它们；之后可以在“已归档的对话”里恢复");
    await expect.element(dialog.getByRole("button", { name: "取消" })).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    await expect.element(dialog).not.toBeInTheDocument();
    expect(calls).not.toContain(`archiveChat ${CHAT}`);

    await archiveChatRow(screen, "解释 merge-tree");
    await dialog.getByRole("button", { name: "归档" }).click();

    await expect.element(dialog).not.toBeInTheDocument();
    await vi.waitFor(() => expect(calls).toContain(`archiveChat ${CHAT}`));
    expect(calls).not.toContain(`selectContainer ${CHAT}`);
  });

  it("hides archived chats from the chats and search, listing them newest first by the names they had", async () => {
    const { screen } = await workbench({ initial: withArchivedChats() });
    const section = screen.getByRole("region", { name: "对话" });

    expect(
      section
        .getByTestId("chat-row")
        .elements()
        .map((row) => row.textContent),
    ).toStrictEqual([expect.stringMatching(/^解释 merge-tree/)]);
    await screen.getByRole("button", { name: "搜索工作区、对话和会话" }).click();
    await userEvent.type(screen.getByRole("textbox", { name: "搜索工作区、对话和会话" }), "周报");
    await expect.element(screen.getByText("没有匹配的工作区、对话或会话")).toBeVisible();
    await userEvent.keyboard("{Escape}");

    await section.getByRole("button", { name: "已归档的对话" }).click();

    await expect
      .element(section.getByRole("list", { name: "已归档的对话" }))
      .toHaveTextContent("解释 rebase5 分钟前恢复周报2 小时前恢复");
  });

  it("restores an archived chat from the list, showing it again, and drops the list with the last", async () => {
    const { screen, calls } = await workbench({
      initial: {
        ...withC1({ archived: true }),
        chats: [chat({ id: CHAT, firstSessionId: "c1", archivedAt: Date.now() })],
      },
    });
    const section = screen.getByRole("region", { name: "对话" });
    await section.getByRole("button", { name: "已归档的对话" }).click();

    await section.getByRole("button", { name: "恢复 解释 merge-tree" }).click();

    await vi.waitFor(() => expect(calls).toContain(`restoreChat ${CHAT}`));
    await expect.element(section.getByTestId("chat-row")).toHaveTextContent("解释 merge-tree1 分钟前");
    await expect.element(section.getByRole("button", { name: "已归档的对话" })).not.toBeInTheDocument();
    expect(calls).not.toContain(`selectContainer ${CHAT}`);
  });

  it("shows eight archived chats before the list scrolls", async () => {
    const base = list();
    const { screen } = await workbench({
      initial: {
        ...base,
        chats: Array.from({ length: 10 }, (_, n) =>
          chat({ id: `cht_${n}`, firstSessionId: null, alias: `对话${n}`, archivedAt: Date.now() - n * 60_000 }),
        ),
      },
    });
    await screen.getByRole("button", { name: "已归档的对话" }).click();
    const shown = screen.getByRole("list", { name: "已归档的对话" }).element();

    expect([shown.clientHeight, shown.scrollHeight]).toStrictEqual([256, 320]);
  });

  it("explains an archive or a restore that failed, and a chat that went", async () => {
    const failures = [new CommandError("internal_error"), new CommandError("chat_not_found")];
    const { screen } = await workbench({
      initial: withArchivedChats(),
      answers: {
        archiveChat: () => Promise.reject(failures.shift()),
        restoreChat: () => Promise.reject(new CommandError("internal_error")),
      },
    });
    const problem = screen.getByRole("alert");

    await archiveChatRow(screen, "解释 merge-tree");
    await expect.element(problem).toHaveTextContent("没能归档这个对话");
    await archiveChatRow(screen, "解释 merge-tree");
    await expect.element(problem).toHaveTextContent("这个对话已经不在了");
    await screen.getByRole("button", { name: "已归档的对话" }).click();
    await screen.getByRole("button", { name: "恢复 周报" }).click();
    await expect.element(problem).toHaveTextContent("没能恢复这个对话");
  });
});

describe("describeArchiveError", () => {
  it("says why archiving failed for each code, and that the host failed otherwise", () => {
    const failures = [
      new CommandError("workspace_dirty"),
      new CommandError("workspace_unsaved_commits"),
      new CommandError("worktree_remove_failed"),
      new CommandError("workspace_not_found"),
      new CommandError("internal_error"),
      new Error("boom"),
    ];

    expect(failures.map(describeArchiveError)).toStrictEqual([
      "有未提交的改动，先提交或丢弃再归档",
      "当前提交不在任何分支上，先建一个分支再归档",
      "git 没能删除这个 worktree",
      "这个工作区已经不在了",
      "宿主出错了，没有完成",
      "宿主出错了，没有完成",
    ]);
  });
});

describe("describeRestoreError", () => {
  it("says why restoring failed for each reason, and that git failed without one", () => {
    const failures = ["no_branch", "dir_taken", "branch_gone", "other"].map(
      (reason) => new CommandError("worktree_restore_failed", { reason }),
    );

    expect([...failures, new CommandError("worktree_restore_failed")].map(describeRestoreError)).toStrictEqual([
      "没能恢复：不知道它归档时的分支",
      "没能恢复：目录已被占用",
      "没能恢复：分支已删除",
      "没能恢复：git 没能加回这个 worktree，分支可能正被别处检出",
      "没能恢复：git 没能加回这个 worktree，分支可能正被别处检出",
    ]);
  });
});

describe("Workbench merge states", () => {
  it("says when a worktree's merge state cannot be told, and why on hover", async () => {
    const initial = list();
    const { screen } = await workbench({
      initial: {
        ...initial,
        workspaces: [
          workspace({
            id: FEATURE,
            branch: "feat/old-git",
            merge: { dirty: true, ahead: 0, verdict: "unknown", reason: "git_too_old" },
          }),
        ],
      },
    });

    const row = screen.getByTestId("workspace-row");
    await expect.element(row).toHaveTextContent("feat/old-git未提交状态未知");
    await expect.element(row.getByText("状态未知")).toHaveAttribute("title", "无法判断是否已合并：git 低于 2.38");
  });
});

describe("Workbench tabs", () => {
  it("shows the container's open sessions as tabs, the active one selected, and switches and closes them", async () => {
    const { screen, calls } = await workbench();
    const tabs = screen.getByRole("tab");

    await expect.element(tabs.nth(0)).toHaveTextContent("重构宿主");
    await expect.element(tabs.nth(1)).toHaveTextContent("调研 pi RPC");
    await expect.element(tabs.nth(1).getByRole("img", { name: "运行中" })).toBeVisible();
    await expect.element(tabs.nth(0)).toHaveAttribute("aria-selected", "true");
    await tabs.nth(1).click();
    await expect.element(tabs.nth(1)).toHaveAttribute("aria-selected", "true");
    await screen.getByRole("button", { name: "关闭 调研 pi RPC" }).click();

    await expect.element(screen.getByRole("tab")).toHaveTextContent("重构宿主");
    expect(calls).toContain("openSession s2");
    expect(calls).toContain("closeTab s2");
  });

  it("lists every session of the container in its history, newest first, marking open ones", async () => {
    const initial = list();
    const { screen, calls } = await workbench({
      initial: {
        ...initial,
        sessions: [
          ...initial.sessions,
          session({ sessionId: "old", containerId: LOCAL, prompt: "旧的", updatedAt: Date.now() - 3 * 3_600_000 }),
          session({ sessionId: "gone", containerId: LOCAL, prompt: "归档的", archived: true }),
        ],
      },
    });

    await screen.getByRole("button", { name: "历史" }).click();
    const items = screen.getByRole("menuitem");

    await expect.element(items.nth(0)).toMatchTextContent(/^重构宿主已打开1 分钟前$/);
    await expect.element(items.nth(2)).toMatchTextContent(/^旧的3 小时前$/);
    await expect.element(screen.getByText("归档的")).not.toBeInTheDocument();
    await items.nth(2).click();
    await vi.waitFor(() => expect(calls).toContain("openSession old"));
  });

  it("creates a session in the workspace with +, then as a draft in a new tab", async () => {
    const { screen, calls } = await workbench();

    await screen.getByRole("button", { name: "新建会话（⌘T）" }).click();

    await vi.waitFor(() => expect(calls).toContain(`createSession ${LOCAL}`));
    await expect.element(screen.getByRole("tab").nth(2)).toHaveTextContent("新会话");
    await expect.element(screen.getByRole("tab").nth(2)).toHaveAttribute("aria-selected", "true");
  });

  it("renames and archives the active session from its menu, and copies its file's path", async () => {
    const { screen, calls } = await workbench();

    await screen.getByRole("button", { name: "当前会话" }).click();
    await screen.getByRole("menuitem", { name: "重命名" }).click();
    await userEvent.fill(screen.getByRole("textbox", { name: "会话名称" }), "新名字");
    await userEvent.keyboard("{Enter}");
    await screen.getByRole("button", { name: "当前会话" }).click();
    await screen.getByRole("menuitem", { name: "归档" }).click();

    await vi.waitFor(() => expect(calls).toContain("archiveSession s1"));
    expect(calls).toContain("renameSession s1 新名字");
    await screen.getByRole("button", { name: "当前会话" }).click();
    await expect.element(screen.getByRole("menuitem", { name: "复制会话文件路径" })).toBeEnabled();
  });

  it("cannot rename a draft or copy its path, as it has no file yet", async () => {
    const initial = list();
    const { screen } = await workbench({
      initial: { ...initial, sessions: [session({ sessionId: "s1", containerId: LOCAL, file: null, state: "draft" })] },
    });

    await screen.getByRole("button", { name: "当前会话" }).click();

    await expect.element(screen.getByRole("menuitem", { name: "复制会话文件路径" })).toBeDisabled();
    await expect.element(screen.getByRole("menuitem", { name: "重命名" })).toBeDisabled();
  });

  it("says beside the active session's menu what a command just did for it", async () => {
    onTestFinished(() => pageNotices().setState(null, true));
    const { screen } = await workbench();
    const menu = screen.getByRole("button", { name: "当前会话" });
    await expect.element(menu).toBeVisible();

    showNotice("s1", "已复制最后一条回复");

    const line = screen.getByRole("status").filter({ hasText: "已复制最后一条回复" });
    await expect.element(line).toBeVisible();
    expect(line.element().parentElement?.contains(menu.element())).toBe(true);
  });

  it("has no display mode to switch, from a menu or with Ctrl+O", async () => {
    const { screen, calls } = await workbench();
    await expect.element(screen.getByRole("button", { name: "当前会话" })).toBeVisible();

    await userEvent.keyboard("{Control>}o{/Control}");

    expect(screen.container.ownerDocument.body.textContent).not.toMatch(/摘要模式|思考模式|详细模式/);
    expect(calls.filter((call) => call.startsWith("setPreferences"))).toStrictEqual([]);
  });
});

describe("Workbench keys and focus", () => {
  it.each([
    ["{Meta>}n{/Meta}", "createChat"],
    ["{Meta>}t{/Meta}", `createSession ${LOCAL}`],
    ["{Meta>}w{/Meta}", "closeTab s1"],
    ["{Meta>}2{/Meta}", "openSession s2"],
    ["{Meta>}{Shift>}]{/Shift}{/Meta}", "openSession s2"],
  ])("acts on %s", async (keys, call) => {
    const { calls } = await workbench();

    await userEvent.keyboard(keys);

    await vi.waitFor(() => expect(calls).toContain(call));
  });

  it("goes to the previous tab with ⌘⇧[, and ignores keys with no tab to go to", async () => {
    const initial = list();
    const { index } = await workbench({
      initial: { ...initial, layout: { container: LOCAL, tabs: { [LOCAL]: { open: ["s1", "s2"], active: "s2" } } } },
    });

    await userEvent.keyboard("{Meta>}{Shift>}[[{/Shift}{/Meta}");
    await vi.waitFor(() => expect(index.getState().layout.tabs[LOCAL]?.active).toBe("s1"));
    await userEvent.keyboard("{Meta>}{Shift>}[[{/Shift}{/Meta}");
    await userEvent.keyboard("{Meta>}9{/Meta}");

    expect(index.getState().layout.tabs[LOCAL]).toStrictEqual({ open: ["s1", "s2"], active: "s1" });
  });

  it("starts a chat with ⌘T when the client is nowhere", async () => {
    const { calls, screen } = await workbench({ initial: { ...list(), layout: { container: null, tabs: {} } } });

    await expect.element(screen.getByText("开始一段对话")).toBeVisible();
    await userEvent.keyboard("{Meta>}t{/Meta}");

    await vi.waitFor(() => expect(calls).toContain("createChat"));
  });

  it("creates a session in the chat the client is in with ⌘T and the tab bar's +, and a new chat with ⌘N", async () => {
    const { calls, screen } = await workbench({
      initial: { ...list(), layout: { container: CHAT, tabs: { [CHAT]: { open: ["c1"], active: "c1" } } } },
    });

    await userEvent.keyboard("{Meta>}t{/Meta}");
    await vi.waitFor(() => expect(calls).toContain(`createSession ${CHAT}`));
    await screen.getByRole("button", { name: "新建会话（⌘T）" }).click();
    await vi.waitFor(() =>
      expect(calls.filter((call) => call.startsWith("create"))).toStrictEqual([
        `createSession ${CHAT}`,
        `createSession ${CHAT}`,
      ]),
    );
    await userEvent.keyboard("{Meta>}n{/Meta}");

    await vi.waitFor(() => expect(calls).toContain("createChat"));
  });

  it("asks the host to look again when the window gains focus", async () => {
    const { calls } = await workbench();

    window.dispatchEvent(new FocusEvent("focus"));

    await vi.waitFor(() => expect(calls).toContain("windowFocused"));
  });

  it("mentions index files reset at the host's start until dismissed", async () => {
    const { screen } = await workbench({ initial: { ...list(), resets: ["projects", "layouts"] } });

    await expect.element(screen.getByText(/项目列表、标签页的文件损坏了，已经重置/)).toBeVisible();
    await screen.getByRole("button", { name: "知道了" }).click();

    await expect.element(screen.getByText(/文件损坏了/)).not.toBeInTheDocument();
  });
});

/** Keeps a draft for each session named. */
function drafts(...sessionIds: string[]): void {
  for (const id of sessionIds) {
    localStorage.setItem(`atrium-draft:${id}`, JSON.stringify({ text: id, pastes: [], files: [] }));
  }
}

/** The sessions that still have a draft. */
function kept(): string[] {
  return Object.keys(localStorage)
    .filter((key) => key.startsWith("atrium-draft:"))
    .map((key) => key.slice("atrium-draft:".length))
    .toSorted();
}

describe("Workbench drafts", () => {
  it("drops the drafts of archived sessions, and of sessions gone from the list while it runs", async () => {
    localStorage.clear();
    onTestFinished(() => localStorage.clear());
    drafts("s1", "s2", "s3", "unseen");
    const initial = list();
    const { index } = await workbench({
      initial: { ...initial, sessions: initial.sessions.map((one) => ({ ...one, archived: one.sessionId === "s2" })) },
    });

    await vi.waitFor(() => expect(kept()).toStrictEqual(["s1", "s3", "unseen"]));
    index.setState({ seq: 2, sessions: index.getState().sessions.filter((one) => one.sessionId !== "s1") });
    await vi.waitFor(() => expect(kept()).toStrictEqual(["s3", "unseen"]));
    // A new host may not have found every session yet: nothing is dropped for being missing.
    index.setState({ generation: "h2", seq: 1, sessions: [] });
    await vi.waitFor(() => expect(index.getState().sessions).toStrictEqual([]));
    expect(kept()).toStrictEqual(["s3", "unseen"]);
  });
});

describe("Workbench attention and hand-off (M1.9)", () => {
  it("marks an error seen once its session shows in a focused window, but never a sign-in problem", async () => {
    const initial = list();
    const { calls, index } = await workbench({
      initial: {
        ...initial,
        sessions: [
          session({ sessionId: "s1", containerId: LOCAL, attention: { reason: "error", at: 1, cleared: false } }),
          session({ sessionId: "s2", containerId: LOCAL, attention: { reason: "auth", at: 1, cleared: false } }),
        ],
      },
    });

    window.dispatchEvent(new FocusEvent("focus"));
    await vi.waitFor(() => expect(calls).toContain("clearAttention s1"));
    index.setState({ layout: { container: LOCAL, tabs: { [LOCAL]: { open: ["s1", "s2"], active: "s2" } } } });
    window.dispatchEvent(new FocusEvent("focus"));

    await vi.waitFor(() => expect(calls.filter((call) => call.startsWith("windowFocused"))).toHaveLength(2));
    expect(calls.filter((call) => call.startsWith("clearAttention"))).toStrictEqual(["clearAttention s1"]);
    expect(index.getState().sessions[0]?.attention).toStrictEqual({ reason: "error", at: 1, cleared: true });
  });

  it("hands the active session to a terminal, then shows only how to go on there, until taken back", async () => {
    const { screen, calls } = await workbench();

    await screen.getByRole("button", { name: "当前会话" }).click();
    await screen.getByRole("menuitem", { name: "在终端中继续" }).click();

    const banner = screen.getByRole("region", { name: "已在终端中继续" });
    await expect.element(banner).toBeVisible();
    await expect.element(banner.getByText("pi --session '/pi/s1.jsonl'")).toBeVisible();
    await expect.element(screen.getByRole("textbox", { name: "消息" })).not.toBeInTheDocument();
    expect(calls).toContain("handOff s1");

    await banner.getByRole("button", { name: "在 Atrium 里继续" }).click();

    await expect.element(banner).not.toBeInTheDocument();
    await expect.element(screen.getByRole("textbox", { name: "消息" })).toBeVisible();
    expect(calls).toContain("takeBack s1");
  });

  it("exports the active session as Markdown, downloading atrium-<id>.md", async () => {
    const downloads = caughtDownloads();
    const { screen } = await workbench();

    await screen.getByRole("button", { name: "当前会话" }).click();
    await screen.getByRole("menuitem", { name: "导出为 Markdown" }).click();

    await vi.waitFor(() => expect(downloads.names).toStrictEqual(["atrium-s1.md"]));
    expect((await downloads.contents()).map(([type]) => type)).toStrictEqual(["text/markdown;charset=utf-8"]);
  });

  it("cannot hand off a draft, which has no file, nor a session running", async () => {
    const initial = list();
    const { screen } = await workbench({
      initial: {
        ...initial,
        sessions: [
          session({ sessionId: "s1", containerId: LOCAL, file: null, state: "draft" }),
          session({ sessionId: "s2", containerId: LOCAL, running: true }),
        ],
      },
    });

    await screen.getByRole("button", { name: "当前会话" }).click();
    await expect.element(screen.getByRole("menuitem", { name: "在终端中继续" })).toBeDisabled();
    await userEvent.keyboard("{Escape}");
    await screen.getByRole("tab").nth(1).click();
    await screen.getByRole("button", { name: "当前会话" }).click();

    await expect.element(screen.getByRole("menuitem", { name: "在终端中继续" })).toBeDisabled();
  });

  it.each<[string, Partial<SessionView>]>([
    ["a message on its way", { pending: [{ clientMessageId: "r1", text: "two" }] }],
    ["a run pi reported", { run: { runId: "run-1", startedAt: 1 } }],
    ["a stop under way", { control: { ...IDLE_CONTROL, stopping: true } }],
    ["pi starting again", { control: { ...IDLE_CONTROL, restarting: true } }],
    [
      "messages in the queue",
      { control: { ...IDLE_CONTROL, queue: [{ id: "q1", text: "two", createdAt: 1, images: 0 }] } },
    ],
  ])("cannot hand off a session with %s, which the host would refuse", async (_, state) => {
    const { screen, views } = await workbench();
    await vi.waitFor(() => expect(views.has("s1")).toBe(true));
    views.get("s1")?.setState(state);

    await screen.getByRole("button", { name: "当前会话" }).click();
    const item = screen.getByRole("menuitem", { name: "在终端中继续" });

    await expect.element(item).toBeDisabled();
    await expect.element(item).toHaveAttribute("title", "先停止运行或清空排队，再交给终端");
  });

  it("opens the settings at 模型与账户 from 去登录 on a turn that failed for its credentials", async () => {
    localStorage.removeItem("atrium.settings.section");
    onTestFinished(() => localStorage.removeItem("atrium.settings.section"));
    const { screen, views } = await workbench();
    await vi.waitFor(() => expect(views.has("s1")).toBe(true));
    views.get("s1")?.setState({
      items: [
        {
          kind: "turn",
          id: "t1",
          user: { text: "你好", images: 0, clientMessageId: null, auto: false, command: null, timestamp: 0 },
          steps: [],
          outcome: "failed",
          error: "OAuth refresh failed for anthropic",
          startedAt: 0,
          durationMs: 1000,
          usage: null,
          changes: [],
        },
      ],
    });

    await screen.getByRole("button", { name: "去登录" }).click();

    const dialog = screen.getByRole("dialog", { name: "设置" });
    await expect.element(dialog.getByRole("heading", { level: 2 })).toHaveTextContent("模型与账户");
    expect(localStorage.getItem("atrium.settings.section")).toBe("accounts");
  });

  it("says why a hand-off was refused", async () => {
    const { screen } = await workbench({
      answers: { handOff: () => Promise.reject(new CommandError("session_busy")) },
    });

    await screen.getByRole("button", { name: "当前会话" }).click();
    await screen.getByRole("menuitem", { name: "在终端中继续" }).click();

    await expect.element(screen.getByText("先停止运行或清空排队，再交给终端")).toBeVisible();
    await expect.element(screen.getByRole("region", { name: "已在终端中继续" })).not.toBeInTheDocument();
  });
});

/**
 * What the model button's canvas shows once its frames have been drawn.
 *
 * @remarks
 * Below the top level the dots settle, so the canvas comes to hold one picture per seed: it is
 * read once it has stayed the same for ten frames.
 *
 * @sideEffects Waits for animation frames.
 * @param button - The model button.
 * @returns The canvas as a data URL.
 */
async function picture(button: Element): Promise<string> {
  const canvas = button.querySelector("canvas");
  if (canvas === null) throw new Error("no canvas");
  let last = "";
  for (let same = 0; same < 10;) {
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const now = canvas.toDataURL();
    same = now === last ? same + 1 : 0;
    last = now;
  }
  return last;
}

describe("Workbench dots", () => {
  it("paints the model button's dots in the pattern of the host's install seed, kept while reconnecting", async () => {
    const opus = {
      providerId: "anthropic",
      modelId: "claude-opus-5-5",
      name: "Claude Opus 5.5",
      contextWindow: 1_000_000,
      maxOutput: 128_000,
      supportsImage: true,
      thinkingLevels: ["off", "low", "medium", "high"],
      fast: null,
    } as const;
    const { screen, connection } = await workbench({
      initial: {
        preferences: {
          ...fakeClient().client.index.getState().preferences,
          lastModel: { providerId: opus.providerId, modelId: opus.modelId },
          thinkingByModel: { "anthropic/claude-opus-5-5": "medium" },
        },
      },
      answers: {
        models: {
          status: "ready",
          models: [{ ...opus, thinkingLevels: [...opus.thinkingLevels] }],
          defaultModel: null,
          error: null,
        },
      },
    });
    const chip = screen.getByRole("button", { name: /模型与推理强度/ });
    await expect.element(chip).toHaveTextContent("Claude Opus 5.5中");
    const first = await picture(chip.element());
    const connected = {
      status: "connected",
      traceId: "t",
      hostVersion: "0",
      hostInstanceId: "h1",
      logDir: "/Users/test/.atrium/logs",
    } as const;

    connection.setState({ ...connected, installSeed: 2 }, true);
    const second = await picture(chip.element());
    connection.setState({ status: "reconnecting", attempt: 1, code: 1006 }, true);
    const reconnecting = await picture(chip.element());
    connection.setState({ ...connected, installSeed: 1 }, true);
    const back = await picture(chip.element());

    expect(second).not.toBe(first);
    expect(reconnecting).toBe(second);
    expect(back).toBe(first);
  });
});
