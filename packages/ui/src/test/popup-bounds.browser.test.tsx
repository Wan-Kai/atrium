import { afterEach, describe, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import "../styles.css";
import { NewChildDialog } from "../children/new-child-dialog";
import { ChildCapsule } from "../children/child-capsule";
import { askForChild, pageNewChild } from "../children/new-child";
import { ArchiveDialog } from "../sidebar/archive";
import { SettingsPanel } from "../settings/settings-panel";
import { ArchiveToasts } from "../sidebar/archive-toasts";
import { RenameField } from "../sidebar/rename-field";
import { Workbench } from "../app/workbench";
import { chat, fakeClient, session, workspace } from "./fake-client";

/** A name at the protocol's limit, without word-breaking opportunities. */
const LONG_NAME = "a".repeat(256);

/**
 * Verifies that the whole surface stays inside the window's safe edges.
 *
 * @remarks
 * Tests the actual layout, rather than the presence of classes intended to constrain it.
 *
 * @sideEffects none
 * @param element - The surface.
 */
function expectInside(element: Element): void {
  const bounds = element.getBoundingClientRect();
  expect(bounds.left).toBeGreaterThanOrEqual(12);
  expect(bounds.top).toBeGreaterThanOrEqual(12);
  expect(bounds.right).toBeLessThanOrEqual(window.innerWidth - 12);
  expect(bounds.bottom).toBeLessThanOrEqual(window.innerHeight - 12);
}

/**
 * Finds the hint referenced by a field's accessible description.
 * @remarks A missing association is a test failure rather than a fallback selector.
 * @sideEffects none
 * @param field - The field that owns the hint.
 * @returns Its hint.
 * @throws When the field has no mounted hint.
 */
function hintOf(field: Element): HTMLElement {
  const id = field.getAttribute("aria-describedby");
  const hint = id === null ? null : document.getElementById(id);
  if (hint === null) throw new Error("rename hint missing");
  return hint;
}

afterEach(async () => {
  pageNewChild().setState(null, true);
  await page.viewport(1280, 820);
});

describe("Window bounds of desktop dialogs", () => {
  it("lets clicks through the empty gap between archive notifications", async () => {
    await page.viewport(640, 420);
    const clicks: string[] = [];
    const screen = await render(
      <>
        <button type="button" style={{ position: "fixed", inset: 0 }} onClick={() => clicks.push("background")}>
          提示下方
        </button>
        <ArchiveToasts
          toasts={[
            { id: 2, name: "second" },
            { id: 1, name: "first" },
          ]}
          onGone={() => undefined}
        />
      </>,
    );
    const toasts = page.getByRole("status").elements();
    await Promise.all(toasts.flatMap((toast) => toast.getAnimations().map((animation) => animation.finished)));
    const first = toasts[0]!.getBoundingClientRect();
    const second = toasts[1]!.getBoundingClientRect();
    await screen
      .getByRole("button", { name: "提示下方", exact: true })
      .click({ position: { x: first.right - 5, y: (first.bottom + second.top) / 2 } });
    expect(clicks).toStrictEqual(["background"]);
  });

  it("leaves normal archive toast shadows and entrance motion unclipped when no scrolling is needed", async () => {
    await page.viewport(800, 600);
    await render(<ArchiveToasts toasts={[{ id: 1, name: "demo" }]} onGone={() => undefined} />);
    const toast = page.getByRole("status").element();
    const stack = toast.parentElement!;
    expect(getComputedStyle(stack).overflowY).toBe("visible");
    expect(getComputedStyle(stack).overflowX).toBe("visible");
    await Promise.all(toast.getAnimations().map((animation) => animation.finished));
    expect(toast.getBoundingClientRect().top).toBe(56);
    expect(toast.getBoundingClientRect().right).toBe(788);
  });

  it("keeps archive notifications above an overlapping child list opened after them", async () => {
    await page.viewport(640, 420);
    const { client } = fakeClient({
      sessions: [
        session({ sessionId: "main", containerId: "cht_a" }),
        ...Array.from({ length: 24 }, (_, index) =>
          session({ sessionId: `child-${index}`, containerId: "cht_a", parent: { sessionId: "main", by: "user" } }),
        ),
      ],
    });
    const screen = await render(
      <>
        <div style={{ position: "fixed", right: 12, bottom: 100, width: 300, display: "flex" }}>
          <ChildCapsule client={client} sessionId="main" />
        </div>
        <ArchiveToasts toasts={[{ id: 1, name: "demo", reason: "归档失败" }]} onGone={() => undefined} />
      </>,
    );
    const toast = page.getByRole("alert").element();
    await Promise.all(toast.getAnimations().map((animation) => animation.finished));
    await screen.getByRole("button", { name: "子对话 24", exact: true }).click();
    const list = screen.getByRole("dialog", { name: "子对话", exact: true }).element();
    await expect.poll(() => list.getAnimations().length).toBe(0);
    const close = page.getByRole("button", { name: "关闭提示" }).element();
    const bounds = close.getBoundingClientRect();
    await expect
      .poll(() =>
        close.contains(document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2)),
      )
      .toBe(true);
  });

  it("scrolls three archive notifications inside a very short window without shrinking their close buttons", async () => {
    await page.viewport(360, 140);
    await render(
      <ArchiveToasts
        toasts={[
          { id: 3, name: "third" },
          { id: 2, name: "second" },
          { id: 1, name: "first" },
        ]}
        onGone={() => undefined}
      />,
    );
    const toasts = page.getByRole("status").elements();
    await Promise.all(toasts.flatMap((toast) => toast.getAnimations().map((animation) => animation.finished)));
    const stack = toasts[0]!.parentElement!;

    expectInside(stack);
    expect(stack.scrollHeight).toBeGreaterThan(stack.clientHeight);
    stack.scrollTop = stack.scrollHeight;
    const close = page.getByRole("button", { name: "关闭提示" }).last().element();
    expectInside(close);
    expect(close.getBoundingClientRect().width).toBe(20);
    expect(toasts.map((toast) => toast.getBoundingClientRect().height)).toStrictEqual([34, 34, 34]);
  });

  it("suspends an open child list under settings and new-child modals, restoring it after each closes", async () => {
    await page.viewport(1280, 820);
    const { client } = fakeClient({
      chats: [chat({ id: "cht_a", firstSessionId: "main" })],
      sessions: [
        session({ sessionId: "main", containerId: "cht_a" }),
        session({ sessionId: "child", containerId: "cht_a", parent: { sessionId: "main", by: "user" } }),
      ],
      layout: { container: "cht_a", tabs: { cht_a: { open: ["main"], active: "main" } } },
    });
    const screen = await render(
      <Workbench
        client={client}
        status={null}
        pickDirectory={undefined}
        setNativeAppearance={undefined}
        openUrl={() => undefined}
        reveal={undefined}
        pathForFile={undefined}
      />,
    );
    await screen.getByRole("button", { name: "子对话 1", exact: true }).click();
    const list = screen.getByRole("dialog", { name: "子对话", exact: true }).element();
    expect(list.matches(":popover-open")).toBe(true);

    await userEvent.keyboard("{Meta>},{/Meta}");
    await expect.element(screen.getByRole("dialog", { name: "设置", exact: true })).toBeVisible();
    await expect.poll(() => list.matches(":popover-open")).toBe(false);
    await screen.getByRole("button", { name: "关闭设置" }).click();
    await expect.poll(() => list.matches(":popover-open")).toBe(true);

    askForChild({ parentSessionId: "main", turnId: null });
    await expect.element(page.getByRole("dialog", { name: "开子对话", exact: true })).toBeVisible();
    await expect.poll(() => list.matches(":popover-open")).toBe(false);
    await page.getByRole("button", { name: "取消", exact: true }).click();
    await expect.poll(() => list.matches(":popover-open")).toBe(true);
    await expect
      .element(screen.getByRole("button", { name: "子对话 1", exact: true }))
      .toHaveAttribute("aria-expanded", "true");
  });

  it("keeps a rename hint visible at the bottom-right edge without moving input focus", async () => {
    await page.viewport(360, 240);
    const screen = await render(
      <div style={{ position: "fixed", right: 12, bottom: 12, width: 140, display: "flex" }}>
        <RenameField initial="demo" label="演示名称" restores={LONG_NAME} onDone={() => undefined} />
      </div>,
    );
    const field = screen.getByRole("textbox", { name: "演示名称" });
    const hint = hintOf(field.element());

    expectInside(hint);
    expect(hint.scrollWidth).toBe(hint.clientWidth);
    expect(hint.getBoundingClientRect().bottom).toBeLessThanOrEqual(field.element().getBoundingClientRect().top - 4);
    await expect.element(field).toHaveFocus();
  });

  it("keeps a long archive failure and its close button inside a narrow window", async () => {
    await page.viewport(360, 320);
    const screen = await render(
      <ArchiveToasts toasts={[{ id: 1, name: LONG_NAME, reason: "失败原因".repeat(100) }]} onGone={() => undefined} />,
    );
    const toast = page.getByRole("alert").element();
    await Promise.all(toast.getAnimations().map((animation) => animation.finished));

    expectInside(toast);
    const close = page.getByRole("button", { name: "关闭提示" });
    expect(close.element().getBoundingClientRect().width).toBe(20);
    await close.click();
    await expect.element(page.getByRole("alert")).toHaveAttribute("data-leaving", "true");
    await screen.unmount();
  });

  it("lets the settings categories scroll in a short window and keeps close inside a narrow window", async () => {
    await page.viewport(600, 240);
    const { client } = fakeClient();
    const choices: string[] = [];
    const screen = await render(
      <SettingsPanel
        client={client}
        section="appearance"
        onSection={(section) => choices.push(section)}
        onClose={() => choices.push("close")}
        openUrl={() => undefined}
        reveal={undefined}
      />,
    );
    const dialog = screen.getByRole("dialog", { name: "设置" }).element();
    const nav = screen.getByRole("navigation", { name: "设置分类" }).element();

    expectInside(dialog);
    expect(nav.scrollHeight).toBeGreaterThan(nav.clientHeight);
    expect(getComputedStyle(nav).overflowY).toBe("auto");
    nav.scrollTop = nav.scrollHeight;
    await screen.getByRole("button", { name: "关于", exact: true }).click();
    expect(choices).toStrictEqual(["about"]);
    await page.viewport(360, 500);
    expectInside(dialog);
    const close = screen.getByRole("button", { name: "关闭设置" });
    expect(close.element().getBoundingClientRect().right).toBeLessThanOrEqual(dialog.getBoundingClientRect().right);
    await close.click();
    expect(choices).toStrictEqual(["about", "close"]);
  });

  it("contains many children while resizing and keeps the last row's menu outside the scrolling list", async () => {
    await page.viewport(800, 600);
    const parent = session({ sessionId: "main", containerId: "cht_a" });
    const children = Array.from({ length: 24 }, (_, index) =>
      session({
        sessionId: `child-${index}`,
        containerId: "cht_a",
        name: `child-${index}`,
        updatedAt: index + 1000,
        parent: { sessionId: "main", by: "user" },
      }),
    );
    const { client } = fakeClient({ sessions: [parent, ...children] });
    const screen = await render(
      <div style={{ position: "fixed", left: 32, right: 32, bottom: 100, display: "flex" }}>
        <ChildCapsule client={client} sessionId="main" />
      </div>,
    );
    await screen.getByRole("button", { name: "子对话 24", exact: true }).click();
    const list = screen.getByRole("dialog", { name: "子对话" }).element();

    expectInside(list);
    expect(list.scrollHeight).toBeGreaterThan(list.clientHeight);
    list.scrollTop = list.scrollHeight;
    await screen.getByRole("button", { name: "「child-0」的操作" }).click();
    const menu = page.getByRole("menu").element();
    expectInside(menu);
    const item = page.getByRole("menuitem", { name: "归档", exact: true }).element();
    const bounds = item.getBoundingClientRect();
    expect(
      item.contains(document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2)),
    ).toBe(true);
    await page.getByRole("menuitem", { name: "打开", exact: true }).click();
    await expect.element(screen.getByRole("dialog", { name: "子对话" })).not.toBeInTheDocument();

    await screen.getByRole("button", { name: "子对话 24", exact: true }).click();
    await page.viewport(360, 340);
    await expect
      .poll(() => screen.getByRole("dialog", { name: "子对话" }).element().getBoundingClientRect().right)
      .toBeLessThanOrEqual(348);
    await expect
      .poll(() => screen.getByRole("dialog", { name: "子对话" }).element().getBoundingClientRect().bottom)
      .toBeLessThanOrEqual(328);
    expectInside(screen.getByRole("dialog", { name: "子对话" }).element());
  });

  it("contains a long archive name and keeps confirmation reachable after scrolling", async () => {
    await page.viewport(360, 260);
    const actions: string[] = [];
    await render(
      <ArchiveDialog
        workspace={workspace({ id: "wks_a", branch: LONG_NAME })}
        running={2}
        onArchive={() => actions.push("archive")}
        onClose={() => actions.push("close")}
      />,
    );
    const dialog = page.getByRole("alertdialog").element();

    expectInside(dialog);
    expect(dialog.scrollWidth).toBe(dialog.clientWidth);
    dialog.scrollTop = dialog.scrollHeight;
    await page.getByRole("button", { name: "归档", exact: true }).click();
    expect(actions).toStrictEqual(["close", "archive"]);
  });

  it("keeps the new-child form and its long parent name inside a small window, with its submit reachable", async () => {
    await page.viewport(360, 320);
    const { client } = fakeClient({
      sessions: [session({ sessionId: "main", containerId: "cht_a", name: LONG_NAME })],
    });
    await render(<NewChildDialog client={client} />);
    askForChild({ parentSessionId: "main", turnId: null });
    const dialog = page.getByRole("dialog", { name: "开子对话" });
    await expect.element(dialog).toBeInTheDocument();
    const form = dialog.element();

    expectInside(form);
    expect(form.scrollWidth).toBe(form.clientWidth);
    form.scrollTop = form.scrollHeight;
    const submit = page.getByRole("button", { name: "开子对话", exact: true });
    await submit.click();
    await expect.element(dialog).not.toBeInTheDocument();
  });
});
