import type { ConnectionState } from "@atrium/client";
import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { createStore } from "zustand/vanilla";
import { useInstallSeed } from "./install-seed";

/**
 * Shows the seed the hook gives.
 *
 * @remarks
 * The hook needs a component to run in.
 *
 * @sideEffects Subscribes to the connection.
 * @param props - The connection.
 * @returns The seed as text.
 */
function Seed({ connection }: { readonly connection: Parameters<typeof useInstallSeed>[0] }) {
  return <output>{useInstallSeed(connection)}</output>;
}

/**
 * A connected state with a seed.
 *
 * @remarks
 * The other fields do not matter here.
 *
 * @sideEffects none
 * @param installSeed - The seed.
 * @returns The state.
 */
function connected(installSeed: number): ConnectionState {
  return { status: "connected", traceId: "t", hostVersion: "0", hostInstanceId: "h1", installSeed, logDir: "/l" };
}

describe("useInstallSeed", () => {
  it("is 1 until a host welcomes, then the host's seed, kept while reconnecting", async () => {
    const connection = createStore<ConnectionState>(() => ({ status: "connecting", traceId: "t" }));
    const screen = await render(<Seed connection={connection} />);
    const seed = screen.getByRole("status");
    const seen: (string | null)[] = [seed.element().textContent];

    connection.setState(connected(4242), true);
    await expect.element(seed).toHaveTextContent("4242");
    connection.setState({ status: "reconnecting", attempt: 1, code: 1006 }, true);
    await screen.rerender(<Seed connection={connection} />);
    seen.push(seed.element().textContent);
    connection.setState(connected(7), true);
    await expect.element(seed).toHaveTextContent("7");

    expect(seen).toStrictEqual(["1", "4242"]);
  });
});
