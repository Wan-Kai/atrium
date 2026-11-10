import type { AtriumClient } from "@atrium/client";
import { describe, expect, it } from "vitest";
import { claimWatch } from "./watch-owner";

/**
 * A client that only records what it was told to watch.
 *
 * @remarks
 * Test support: `claimWatch` calls nothing else of the client.
 *
 * @sideEffects none
 * @returns The client and the sets it was told to watch, in order.
 */
function recordingClient(): { readonly client: AtriumClient; readonly sets: string[][] } {
  const sets: string[][] = [];
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a test double with the one method used.
  const client = {
    watch: (sessionIds: readonly string[]) => {
      sets.push([...sessionIds]);
      return Promise.resolve();
    },
  } as unknown as AtriumClient;
  return { client, sets };
}

describe("the owner of the watched set (T8 review fix 14)", () => {
  it("watches what it is asked, and lets go of it by emptying the set", async () => {
    const { client, sets } = recordingClient();

    const claim = claimWatch(client, ["s1"]);
    await claim.watched;
    claim.release();

    expect(sets).toStrictEqual([["s1"], []]);
  });

  it("does not undo the watch of a newer owner when an older one lets go late, and the newer one still can", () => {
    const { client, sets } = recordingClient();

    const older = claimWatch(client, ["s1"]);
    const newer = claimWatch(client, ["s2"]);
    older.release();
    expect(sets).toStrictEqual([["s1"], ["s2"]]);
    newer.release();

    expect(sets).toStrictEqual([["s1"], ["s2"], []]);
  });

  it("keeps the claims of one client apart from another's", () => {
    const one = recordingClient();
    const other = recordingClient();

    const first = claimWatch(one.client, ["s1"]);
    claimWatch(other.client, ["s2"]);
    first.release();

    expect(one.sets).toStrictEqual([["s1"], []]);
  });
});
