import { type Connection, createConnection } from "@atrium/client";
import { useEffect, useState } from "react";
import { useConnectionState } from "../state/use-connection-state";
import { clientId, readBootstrap } from "./bootstrap";
import { ConnectionStatus } from "./connection-status";

/**
 * Root component: connects to the host and shows the connection state.
 *
 * @remarks
 * M1.1 only proves the path Electron → UI → WebSocket → host works end to end; the sidebar,
 * tabs and transcript replace this screen in later milestones.
 *
 * @sideEffects On mount, asks the desktop bridge for the host address and opens a WebSocket;
 * disconnects on unmount.
 * @returns The app shell.
 */
export function App() {
  const [connection, setConnection] = useState<Connection | null>(null);

  useEffect(() => {
    let active = true;
    let opened: Connection | null = null;

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
      const bootstrap = await readBootstrap();
      if (!active || bootstrap === null) return;
      opened = createConnection({
        url: bootstrap.hostUrl.replace(/^http/, "ws"),
        token: bootstrap.token,
        clientId: clientId(localStorage),
      });
      setConnection(opened);
      await opened.connect();
    }

    void open();
    return () => {
      active = false;
      opened?.disconnect();
    };
  }, []);

  return (
    <main className="flex h-full flex-col items-center justify-center gap-2 bg-background">
      <h1 className="text-xl font-semibold">Atrium</h1>
      {connection === null ? <ConnectionStatus state={null} /> : <LiveStatus connection={connection} />}
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
 * @param props - The connection to watch.
 * @returns The status line.
 */
function LiveStatus({ connection }: { readonly connection: Connection }) {
  return <ConnectionStatus state={useConnectionState(connection)} />;
}
