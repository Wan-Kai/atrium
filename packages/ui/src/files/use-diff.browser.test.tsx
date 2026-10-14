import type { AtriumClient } from "@atrium/client";
import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { useStore } from "zustand";
import { fakeClient, session } from "../test/fake-client";
import { useRunEnds } from "./use-diff";

const W = "wks_0000000000000001";

/**
 * How many of W's sessions run, and how many runs there have ended.
 *
 * @sideEffects Subscribes to the client's list.
 * @param props - The client.
 * @returns The two, as `running:ends`.
 */
function Ends({ client }: { readonly client: AtriumClient }) {
  const running = useStore(
    client.index,
    (index) => index.sessions.filter((each) => each.containerId === W && each.running).length,
  );
  return <p>{`${running}:${useRunEnds(client, W)}`}</p>;
}

describe("useRunEnds", () => {
  it("counts a run in the workspace ending, not one starting nor one elsewhere", async () => {
    const elsewhere = "wks_0000000000000002";
    const { client, index } = fakeClient({
      sessions: [
        session({ sessionId: "s1", containerId: W, running: true }),
        session({ sessionId: "s3", containerId: elsewhere, running: true }),
        session({ sessionId: "s4", containerId: elsewhere, running: true }),
      ],
    });
    const screen = await render(<Ends client={client} />);
    const said = screen.getByRole("paragraph");
    await expect.element(said).toHaveTextContent("1:0");

    index.setState({
      sessions: [
        session({ sessionId: "s1", containerId: W, running: true }),
        session({ sessionId: "s2", containerId: W, running: true }),
        session({ sessionId: "s3", containerId: elsewhere, running: false }),
        session({ sessionId: "s4", containerId: elsewhere, running: false }),
      ],
    });
    await expect.element(said).toHaveTextContent("2:0");
    index.setState({
      sessions: [
        session({ sessionId: "s1", containerId: W, running: false }),
        session({ sessionId: "s2", containerId: W, running: true }),
      ],
    });

    await expect.element(said).toHaveTextContent("1:1");
  });

  it("counts a run ending as another starts, from none running", async () => {
    const { client, index } = fakeClient({ sessions: [session({ sessionId: "s1", containerId: W, running: false })] });
    const screen = await render(<Ends client={client} />);
    const said = screen.getByRole("paragraph");
    await expect.element(said).toHaveTextContent("0:0");
    index.setState({ sessions: [session({ sessionId: "s1", containerId: W, running: true })] });
    await expect.element(said).toHaveTextContent("1:0");

    index.setState({
      sessions: [
        session({ sessionId: "s1", containerId: W, running: false }),
        session({ sessionId: "s2", containerId: W, running: true }),
      ],
    });

    await expect.element(said).toHaveTextContent("1:1");
  });
});
