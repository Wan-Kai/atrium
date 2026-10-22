import { CommandError } from "@atrium/client";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { page, userEvent } from "vitest/browser";
import "../styles.css";
import { fakeClient } from "../test/fake-client";
import { type MessageImages, MessageImagesContext, messageImages } from "./message-images";
import { UserBubble } from "./messages";

/** A 1×1 PNG, as base64. */
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

/** The same PNG as a `data:` address. */
const PNG_URL = `data:image/png;base64,${PNG}`;

/**
 * A generated landscape image, distinct from the one-pixel thumbnail fixture.
 *
 * @remarks Real dimensions let preview tests verify uncropped pixels and actual zoom geometry.
 * @sideEffects Creates a detached canvas.
 * @returns The PNG address.
 */
function landscapeImage(): string {
  const canvas = document.createElement("canvas");
  canvas.width = 640;
  canvas.height = 400;
  const context = canvas.getContext("2d");
  if (context === null) throw new Error("no 2d context");
  context.fillStyle = "#5e84ff";
  context.fillRect(0, 0, 640, 400);
  context.fillStyle = "#ffe0a0";
  context.fillRect(80, 80, 480, 240);
  return canvas.toDataURL("image/png");
}

/**
 * Images where only the message `q1` was sent from this page, with two previews, and the host has
 * the turns' images whose `load` says.
 *
 * @remarks
 * Records each load as `turn/place`.
 *
 * @sideEffects none until loaded; loads are recorded.
 * @param load - The host's answer.
 * @param previews - The images retained for `q1`.
 * @returns The images and the loads asked for.
 */
function images(
  load: (turnId: string, index: number) => Promise<string>,
  previews: readonly string[] = [PNG_URL, PNG_URL],
) {
  const loads: string[] = [];
  const value: MessageImages = {
    sent: (clientMessageId) => (clientMessageId === "q1" ? previews : null),
    load: (turnId, index) => {
      loads.push(`${turnId}/${index}`);
      return load(turnId, index);
    },
  };
  return { value, loads };
}

/**
 * The addresses of the thumbnails in the n-th bubble, or how each one stands when it has none.
 *
 * @remarks
 * A thumbnail is an image with an address, or a frame named for its state.
 *
 * @sideEffects none
 * @param root - Where the bubbles are.
 * @param bubble - Which bubble, from 0.
 * @returns One entry per thumbnail.
 */
function thumbnails(root: HTMLElement, bubble: number): string[] {
  const frame = root.querySelectorAll('[data-testid="message-images"]')[bubble];
  return [...(frame?.querySelectorAll('[role="img"], img') ?? [])].map(
    (one) => one.getAttribute("src") ?? one.getAttribute("aria-label") ?? "",
  );
}

/** Fails the way the host does when it has no such image. */
const unavailable = () => Promise.reject(new Error("image_unavailable"));

/**
 * A host that has the first image of each message and not the others.
 *
 * @sideEffects none
 * @param _turnId - The turn.
 * @param index - The image's place.
 * @returns The image, or a failure.
 */
function onlyTheFirst(_turnId: string, index: number): Promise<string> {
  return index === 0 ? Promise.resolve(PNG_URL) : unavailable();
}

/**
 * A host that has every image only once `has` is set.
 *
 * @remarks
 * As a running turn's images become available once it ends.
 *
 * @sideEffects none
 * @returns The switch, the load for {@link images} and the answer for the fake client.
 */
function later() {
  const state = {
    has: false,
    load: () => (state.has ? Promise.resolve(PNG_URL) : unavailable()),
    answer: async () => (state.has ? { mimeType: "image/webp" as const, data: "eA==" } : undefined),
  };
  return state;
}

/**
 * A host whose first answer waits for `release` and has no image, and whose later ones have it.
 *
 * @remarks
 * As for a turn that ended while its image was asked for.
 *
 * @sideEffects none until answered; counts the answers.
 * @returns The release and the answer for the fake client.
 */
function slowFirst() {
  const gate = Promise.withResolvers<void>();
  let asked = 0;
  return {
    release: () => gate.resolve(),
    answer: async () => {
      asked += 1;
      if (asked > 1) return { mimeType: "image/png" as const, data: "eA==" };
      await gate.promise;
      return undefined;
    },
  };
}

describe("MessageThumbnails", () => {
  it.each(["q1", null])(
    "opens image previews from the user bubble with client message id %s",
    async (clientMessageId) => {
      await page.viewport(1000, 800);
      const source = landscapeImage();
      const sources = [PNG_URL, source];
      const { value, loads } = images((_, index) => Promise.resolve(present(sources[index])), sources);
      const screen = await render(
        <MessageImagesContext value={value}>
          <UserBubble text="看看这两张" images={2} turnId="t1" clientMessageId={clientMessageId} settled />
        </MessageImagesContext>,
      );
      const thumbnail = screen.getByTestId("message-images").getByRole("img", { name: "图片 2" });
      await expect.element(thumbnail).toHaveAttribute("src", source);
      const fetchedBefore = [...loads];
      await userEvent.click(thumbnail);
      const preview = screen.getByRole("dialog", { name: "图片预览" });
      await expect.element(preview).toBeVisible();
      const fullImage = preview.getByRole("img", { name: "图片 2" });
      await expect.element(fullImage).toHaveAttribute("src", source);
      await expect.element(preview.getByLabelText("缩放比例")).toHaveTextContent("100%");
      expect(fullImage.element().getBoundingClientRect().width).toBe(640);
      expect(fullImage.element().getBoundingClientRect().height).toBe(400);
      await preview.getByRole("button", { name: "放大", exact: true }).click();
      await expect.element(preview.getByLabelText("缩放比例")).toHaveTextContent("125%");
      expect(fullImage.element().getBoundingClientRect().width).toBe(800);
      await preview.getByRole("button", { name: "适应窗口" }).click();
      await expect.element(preview.getByLabelText("缩放比例")).toHaveTextContent("100%");
      await userEvent.keyboard("{Escape}");
      await expect.element(preview).not.toBeInTheDocument();
      await expect.element(screen.getByRole("button", { name: "放大图片：图片 2" })).toHaveFocus();
      await userEvent.keyboard("{Enter}");
      await expect.element(preview).toBeVisible();
      await preview.getByRole("button", { name: "关闭预览" }).click();
      await expect.element(preview).not.toBeInTheDocument();
      await expect.element(screen.getByRole("button", { name: "放大图片：图片 2" })).toHaveFocus();
      expect(loads).toStrictEqual(fetchedBefore);
    },
  );

  it.each(["q1", null])(
    "closes the preview on source change and unmount for client message id %s",
    async (clientMessageId) => {
      const view = (src: string) => (
        <MessageImagesContext value={{ sent: () => [src], load: () => Promise.resolve(src) }}>
          <UserBubble text="图片" images={1} turnId="t1" clientMessageId={clientMessageId} settled />
        </MessageImagesContext>
      );
      const screen = await render(view(PNG_URL));
      await screen.getByRole("button", { name: "放大图片：图片 1" }).click();
      const first = screen.getByRole("dialog", { name: "图片预览" }).element() as HTMLDialogElement;
      await screen.rerender(view(landscapeImage()));
      await vi.waitFor(() => expect(document.querySelector("dialog[open]")).toBeNull());
      expect(first.open).toBe(false);
      await screen.getByRole("button", { name: "放大图片：图片 1" }).click();
      const second = screen.getByRole("dialog", { name: "图片预览" }).element() as HTMLDialogElement;
      await screen.rerender(<button type="button">另一个会话</button>);
      expect(document.querySelector("dialog")).toBeNull();
      expect(second.open).toBe(false);
      await screen.getByRole("button", { name: "另一个会话" }).click();
      await expect.element(screen.getByRole("button", { name: "另一个会话" })).toHaveFocus();
    },
  );

  it("shows the previews of a message sent from here and fetches the images of others, each on its own", async () => {
    const { value, loads } = images(onlyTheFirst);
    const screen = await render(
      <MessageImagesContext value={value}>
        <UserBubble text="这里发的" images={2} turnId="t1" clientMessageId="q1" settled />
        <UserBubble text="历史里的" images={2} turnId="t2" clientMessageId={null} settled />
      </MessageImagesContext>,
    );

    await vi.waitFor(() =>
      expect([thumbnails(screen.container, 0), thumbnails(screen.container, 1)]).toStrictEqual([
        [PNG_URL, PNG_URL],
        [PNG_URL, "图片不可用"],
      ]),
    );
    expect(loads).toStrictEqual(["t2/0", "t2/1"]);
    await expect.element(screen.getByRole("img", { name: "图片不可用" })).toHaveAttribute("title", "图片不可用");
    expect(screen.getByRole("img", { name: "图片不可用" }).element().closest("button")).toBeNull();
  });

  it("shows 64 px squares cropped to fill, in a row above the bubble that wraps", async () => {
    const { value } = images(() => Promise.resolve(PNG_URL));
    const screen = await render(
      <div style={{ width: 400 }}>
        <MessageImagesContext value={value}>
          <UserBubble text="十张" images={10} turnId="t1" settled />
        </MessageImagesContext>
      </div>,
    );
    const row = screen.getByTestId("message-images").element();
    await vi.waitFor(() => expect(row.querySelectorAll("img")).toHaveLength(10));
    const shown = [...row.querySelectorAll("img")];
    const bubble = screen.getByTestId("user-text").element().getBoundingClientRect();

    expect(shown.map((one) => [one.getBoundingClientRect().width, one.getBoundingClientRect().height])).toStrictEqual(
      Array.from({ length: 10 }, () => [64, 64]),
    );
    expect(getComputedStyle(present(shown[0])).objectFit).toBe("cover");
    // 80% of 400 px holds four in a row.
    expect(new Set(shown.map((one) => one.getBoundingClientRect().top)).size).toBe(3);
    expect(row.getBoundingClientRect().bottom).toBeLessThanOrEqual(bubble.top);
  });

  it("shows grey frames while a message is pending or its images load, and asks again once its turn ends", async () => {
    const host = later();
    const { value, loads } = images(host.load);
    const view = (settled: boolean) => (
      <MessageImagesContext value={value}>
        <UserBubble text="还在等" images={1} clientMessageId="q9" />
        <UserBubble text="运行中" images={1} turnId="live-1" clientMessageId="q8" settled={settled} />
      </MessageImagesContext>
    );
    const screen = await render(view(false));
    await vi.waitFor(() => expect(thumbnails(screen.container, 1)).toStrictEqual(["图片不可用"]));

    host.has = true;
    await screen.rerender(view(true));

    await vi.waitFor(() => expect(thumbnails(screen.container, 1)).toStrictEqual([PNG_URL]));
    expect(thumbnails(screen.container, 0)).toStrictEqual(["正在加载图片"]);
    await expect.element(screen.getByTestId("message-images").nth(0).getByRole("button")).not.toBeInTheDocument();
    expect(loads).toStrictEqual(["live-1/0", "live-1/0"]);
  });
});

/**
 * A value that must be there.
 *
 * @sideEffects none
 * @param value - The value.
 * @returns It.
 * @throws When it is missing.
 */
function present<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("missing");
  return value;
}

describe("messageImages", () => {
  it("fetches each image once for the page, across sessions apart, and again after the host had none", async () => {
    const host = later();
    const { client, calls } = fakeClient({}, { image: host.answer });
    const one = messageImages(client, "s1");
    const again = messageImages(client, "s1");
    const other = messageImages(client, "s2");

    await expect(one.load("t1", 0, true)).rejects.toStrictEqual(new CommandError("image_unavailable"));
    host.has = true;
    const loaded = await Promise.all([
      one.load("t1", 0, true),
      again.load("t1", 0, true),
      other.load("t1", 0, true),
      one.load("t1", 1, true),
    ]);

    expect(loaded).toStrictEqual(Array.from({ length: 4 }, () => "data:image/webp;base64,eA=="));
    expect(calls).toStrictEqual([
      "fetchImage s1 t1 0",
      "fetchImage s1 t1 0",
      "fetchImage s2 t1 0",
      "fetchImage s1 t1 1",
    ]);
  });

  it("asks again once the turn has ended, though the ask from while it ran is still on its way", async () => {
    const host = slowFirst();
    const { client, calls } = fakeClient({}, { image: host.answer });
    const shown = messageImages(client, "s1");

    const running = shown.load("t1", 0, false);
    const ended = shown.load("t1", 0, true);
    host.release();

    await expect(running).rejects.toStrictEqual(new CommandError("image_unavailable"));
    expect(await ended).toBe("data:image/png;base64,eA==");
    expect(calls).toStrictEqual(["fetchImage s1 t1 0", "fetchImage s1 t1 0"]);
  });

  it("keeps the latest 100 fetched images", async () => {
    const { client, calls } = fakeClient({}, { image: async () => ({ mimeType: "image/png", data: "eA==" }) });
    const shown = messageImages(client, "s1");

    for (let turn = 0; turn <= 100; turn += 1) await shown.load(`t${turn}`, 0, true);
    await shown.load("t1", 0, true);
    await shown.load("t0", 0, true);

    expect(calls.slice(-1)).toStrictEqual(["fetchImage s1 t0 0"]);
    expect(calls).toHaveLength(102);
  });

  it("gives the client's previews of messages sent from this page", async () => {
    const { client } = fakeClient();
    await client.prompt("s1", "看图", ["u1"], [PNG_URL]).catch(() => undefined);

    expect([messageImages(client, "s1").sent("q1"), messageImages(client, "s1").sent("q9")]).toStrictEqual([
      [PNG_URL],
      null,
    ]);
  });
});
