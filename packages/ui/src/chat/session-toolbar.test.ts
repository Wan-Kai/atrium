import type { AtriumClient, SessionView } from "@atrium/client";
import type { TranscriptItem } from "@atrium/protocol";
import { describe, expect, it } from "vitest";
import { type StoreApi, createStore } from "zustand/vanilla";
import { wholeTranscript } from "./session-toolbar";

/** A notice with the given id. */
function notice(id: string): TranscriptItem {
  return { kind: "notice", id, notice: "compacted", tokensBefore: 0, summary: "", timestamp: 0 };
}

/**
 * A client whose session s1 has `shown` items and gives `pages` one at a time when asked for older ones.
 *
 * @remarks
 * A page of `null` leaves the view as it is, as when the fetch found the transcript rebuilt.
 */
function clientWith(shown: TranscriptItem[], pages: (TranscriptItem[] | null)[]) {
  const store: StoreApi<SessionView> = createStore<SessionView>(() => ({
    sessionId: "s1",
    status: "ready",
    epoch: 1,
    seq: 0,
    items: shown,
    hasOlder: pages.length > 0,
    run: null,
    pending: [],
  }));
  let asked = 0;
  const client = {
    session: (sessionId: string) => (sessionId === "s1" ? store : undefined),
    loadOlder: async () => {
      const page = pages[asked];
      asked += 1;
      if (page === null || page === undefined) return;
      store.setState({ items: [...page, ...store.getState().items], hasOlder: asked < pages.length });
    },
  } as unknown as AtriumClient;
  return { client, asked: () => asked };
}

describe("wholeTranscript", () => {
  it("fetches older pages until there are none, and returns everything in order", async () => {
    const { client, asked } = clientWith(
      [notice("n5")],
      [
        [notice("n3"), notice("n4")],
        [notice("n1"), notice("n2")],
      ],
    );

    expect((await wholeTranscript(client, "s1")).map((item) => item.id)).toStrictEqual(["n1", "n2", "n3", "n4", "n5"]);
    expect(asked()).toBe(2);
  });

  it("fails rather than export part of the session when a page brings nothing new", async () => {
    const { client, asked } = clientWith([notice("n5")], [null, [notice("n1")]]);

    await expect(wholeTranscript(client, "s1")).rejects.toThrow("the transcript changed while it was being exported");
    expect(asked()).toBe(1);
  });

  it("fails when the host rebuilt the transcript meanwhile, or the view went back to loading", async () => {
    const rebuilt = clientWith([notice("n5")], [[notice("n4")], [notice("n1")]]);
    const store = rebuilt.client.session("s1");
    rebuilt.client.loadOlder = async () => store?.setState({ epoch: 2, items: [notice("n9")] });
    const reloading = clientWith([notice("n5")], [[notice("n4")], [notice("n1")]]);
    const other = reloading.client.session("s1");
    reloading.client.loadOlder = async () =>
      other?.setState({ status: "loading", items: [notice("n0"), notice("n5")] });

    await expect(wholeTranscript(rebuilt.client, "s1")).rejects.toThrow("changed");
    await expect(wholeTranscript(reloading.client, "s1")).rejects.toThrow("changed");
  });

  it("exports what the view has when there is nothing older", async () => {
    const { client, asked } = clientWith([notice("n5")], []);

    expect((await wholeTranscript(client, "s1")).map((item) => item.id)).toStrictEqual(["n5"]);
    expect(asked()).toBe(0);
  });

  it("has nothing for a session it does not watch", async () => {
    const { client, asked } = clientWith([notice("n5")], [[notice("n1")]]);

    expect(await wholeTranscript(client, "s9")).toStrictEqual([]);
    expect(asked()).toBe(0);
  });
});
