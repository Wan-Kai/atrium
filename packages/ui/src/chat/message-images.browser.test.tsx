import { CommandError } from "@atrium/client";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import "../styles.css";
import { fakeClient } from "../test/fake-client";
import { type MessageImages, MessageImagesContext, messageImages } from "./message-images";
import { UserBubble } from "./messages";

/** A 1×1 PNG, as base64. */
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

/** The same PNG as a `data:` address. */
const PNG_URL = `data:image/png;base64,${PNG}`;

/**
 * Images where only the message `q1` was sent from this page, with two previews, and the host has
 * the turns' images whose `load` says.
 *
 * @remarks
 * Records each load as `turn/place`.
 *
 * @sideEffects none until loaded; loads are recorded.
 * @param load - The host's answer.
 * @returns The images and the loads asked for.
 */
function images(load: (turnId: string, index: number) => Promise<string>) {
  const loads: string[] = [];
  const value: MessageImages = {
    sent: (clientMessageId) => (clientMessageId === "q1" ? [PNG_URL, PNG_URL] : null),
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

describe("MessageThumbnails", () => {
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

    await expect(one.load("t1", 0)).rejects.toStrictEqual(new CommandError("image_unavailable"));
    host.has = true;
    const loaded = await Promise.all([one.load("t1", 0), again.load("t1", 0), other.load("t1", 0), one.load("t1", 1)]);

    expect(loaded).toStrictEqual(Array.from({ length: 4 }, () => "data:image/webp;base64,eA=="));
    expect(calls).toStrictEqual([
      "fetchImage s1 t1 0",
      "fetchImage s1 t1 0",
      "fetchImage s2 t1 0",
      "fetchImage s1 t1 1",
    ]);
  });

  it("keeps the latest 100 fetched images", async () => {
    const { client, calls } = fakeClient({}, { image: async () => ({ mimeType: "image/png", data: "eA==" }) });
    const shown = messageImages(client, "s1");

    for (let turn = 0; turn <= 100; turn += 1) await shown.load(`t${turn}`, 0);
    await shown.load("t1", 0);
    await shown.load("t0", 0);

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
