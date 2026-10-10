import { type AtriumClient, createAtriumClient } from "@atrium/client";
import type { Appearance } from "@atrium/protocol";
import { useEffect, useState } from "react";
import { DisplayModeContext, createDisplayMode, followPreferences } from "../state/display-mode";
import { useConnectionState } from "../state/use-connection-state";
import { clientId, desktopBridge, readBootstrap } from "./bootstrap";
import { ConnectionStatus, type StatusView } from "./connection-status";
import { installIssueReporting } from "./issue-reporting";
import { Workbench } from "./workbench";

/** The app before a connection exists, or the connection once it does. */
type Shell =
  | { readonly kind: "waiting"; readonly view: StatusView }
  | { readonly kind: "connected"; readonly client: AtriumClient };

/**
 * Root component: connects to the host, then shows the workbench.
 *
 * @remarks
 * Until the desktop bridge answers, the screen says it is starting rather than claiming the app
 * runs outside the desktop shell, and a failed bridge call is shown instead of becoming an
 * unhandled rejection. Once connected, the workbench carries the connection's status line.
 *
 * @sideEffects On mount, asks the desktop bridge for the host address, opens a WebSocket and
 * starts reporting UI problems to the host; disconnects on unmount.
 * @returns The app shell.
 */
export function App() {
  const [shell, setShell] = useState<Shell>({ kind: "waiting", view: { status: "starting" } });

  useEffect(() => {
    let active = true;
    let opened: AtriumClient | null = null;
    let stopReporting: (() => void) | undefined;

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
      stopReporting = installIssueReporting(opened, window);
      setShell({ kind: "connected", client: opened });
      await opened.connect();
    }

    // Fire and forget: open() handles its own failures and reports them through component state.
    void open();
    return () => {
      active = false;
      stopReporting?.();
      opened?.disconnect();
    };
  }, []);

  if (shell.kind === "waiting") {
    return (
      <main className="flex h-full items-center justify-center bg-[var(--main)] text-[length:var(--fs-sm)]">
        <ConnectionStatus view={shell.view} />
      </main>
    );
  }
  return <Connected client={shell.client} />;
}

/**
 * Sends the appearance to the desktop shell.
 *
 * @remarks
 * For the window's own parts, such as the title bar; the page sets its own.
 *
 * @sideEffects Calls the desktop bridge.
 * @param appearance - The user's choice.
 */
function setNativeAppearance(appearance: Appearance): void {
  // Fire and forget: the page's own appearance does not depend on it.
  void desktopBridge()
    ?.setAppearance?.(appearance)
    .catch(() => undefined);
}

/**
 * Opens an address in the user's browser.
 *
 * @remarks
 * In the desktop app the window's open handler hands an http(s) address to the system browser and
 * opens nothing inside (security.md, "Electron").
 *
 * @sideEffects Asks the page to open a window.
 * @param url - The address.
 */
function openUrl(url: string): void {
  window.open(url, "_blank", "noopener");
}

/**
 * Shows a path in the Finder.
 *
 * @remarks
 * The desktop shell takes only an absolute path that exists.
 *
 * @sideEffects Calls the desktop bridge.
 * @param path - The path.
 */
function reveal(path: string): void {
  // Fire and forget: nothing to tell the user if the Finder does not come up.
  void desktopBridge()
    ?.reveal?.(path)
    .catch(() => undefined);
}

/**
 * The app once a client exists: the display mode store and the workbench.
 *
 * @remarks
 * The display mode follows the host's preferences and saves changes there (SPEC-0001,
 * "项目、工作区与会话").
 *
 * @sideEffects Subscribes the display mode to the client's list while mounted.
 * @param props - The client.
 * @returns The workbench.
 */
function Connected({ client }: { readonly client: AtriumClient }) {
  const [displayMode] = useState(() =>
    createDisplayMode(client.index.getState().preferences.displayMode, (mode) => {
      // Fire and forget: the list shows the change at once, and the host keeps it.
      void client.setPreferences({ displayMode: mode }).catch(() => undefined);
    }),
  );
  useEffect(() => followPreferences(displayMode, client), [displayMode, client]);
  const bridge = desktopBridge();
  return (
    <DisplayModeContext value={displayMode}>
      <Workbench
        client={client}
        status={<LiveStatus client={client} />}
        pickDirectory={
          bridge?.pickDirectory === undefined
            ? undefined
            : () => desktopBridge()?.pickDirectory?.() ?? Promise.resolve(null)
        }
        setNativeAppearance={bridge?.setAppearance === undefined ? undefined : setNativeAppearance}
        openUrl={openUrl}
        reveal={bridge?.reveal === undefined ? undefined : reveal}
      />
    </DisplayModeContext>
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
