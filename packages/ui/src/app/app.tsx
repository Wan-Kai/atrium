import { type AtriumClient, createAtriumClient } from "@atrium/client";
import { useEffect, useState } from "react";
import { useConnectionState } from "../state/use-connection-state";
import { clientId, readBootstrap } from "./bootstrap";
import { ChatScreen } from "../chat/chat-screen";
import { ConnectionStatus, type StatusView } from "./connection-status";

/** The app before a connection exists, or the connection once it does. */
type Shell =
  | { readonly kind: "waiting"; readonly view: StatusView }
  | { readonly kind: "connected"; readonly client: AtriumClient };

/**
 * Root component: connects to the host and shows the connection state.
 *
 * @remarks
 * A status line over M1.3's conversation screen; the sidebar and tabs come with M1.5. Until the desktop bridge answers,
 * the screen says it is starting rather than claiming the app runs outside the desktop shell, and
 * a failed bridge call is shown instead of becoming an unhandled rejection.
 *
 * @sideEffects On mount, asks the desktop bridge for the host address and opens a WebSocket;
 * disconnects on unmount.
 * @returns The app shell.
 */
export function App() {
  const [shell, setShell] = useState<Shell>({ kind: "waiting", view: { status: "starting" } });

  useEffect(() => {
    let active = true;
    let opened: AtriumClient | null = null;

    /**
     * Opens the connection once the bootstrap data arrives, unless the component unmounted first.
     *
     * @remarks
     * React may unmount before the IPC round trip finishes; the `active` flag prevents a socket
     * that nothing would ever close.
     *
     * @sideEffects Asks the bridge for bootstrap data; opens a WebSocket; sets component state.
     */
    async function open(): Promise<void> {
      const bootstrap = await readBootstrap().catch(() => "failed" as const);
      if (!active) return;
      if (bootstrap === "failed" || bootstrap === null) {
        setShell({
          kind: "waiting",
          view: { status: bootstrap === null ? "unavailable" : "bootstrap-failed" },
        });
        return;
      }
      opened = createAtriumClient({
        url: bootstrap.hostUrl.replace(/^http/, "ws"),
        token: bootstrap.token,
        clientId: clientId(localStorage),
      });
      setShell({ kind: "connected", client: opened });
      await opened.connect();
    }

    // Fire and forget: open() handles its own failures and reports them through component state.
    void open();
    return () => {
      active = false;
      opened?.disconnect();
    };
  }, []);

  return (
    <main className="flex h-full flex-col bg-[var(--main)]">
      <header className="flex h-12 shrink-0 items-center justify-center text-[length:var(--fs-sm)]">
        {shell.kind === "waiting" ? <ConnectionStatus view={shell.view} /> : <LiveStatus client={shell.client} />}
      </header>
      {shell.kind === "connected" ? <ChatScreen client={shell.client} /> : null}
    </main>
  );
}

/**
 * Shows the live state of an open connection.
 *
 * @remarks
 * Split out so the store subscription only exists once a connection does.
 *
 * @sideEffects Subscribes to the connection's store.
 * @param props - The client whose connection to watch.
 * @returns The status line.
 */
function LiveStatus({ client }: { readonly client: AtriumClient }) {
  return <ConnectionStatus view={useConnectionState(client)} />;
}
