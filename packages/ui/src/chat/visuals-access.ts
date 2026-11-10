import type { AtriumClient } from "@atrium/client";
import { desktopBridge } from "../app/bootstrap";
import type { FileOpener } from "./file-opener";
import type { UiClock } from "../state/clock";
import type { VisualsAccess } from "./visual-card";
import { VisualPresses } from "./visual-presses";

/** The window's presses, by what they landed on, heard once for the page from the desktop shell. */
let presses: VisualPresses<Element> | null = null;

/**
 * The window's presses, starting to hear them on first use.
 *
 * @remarks
 * One listener for the page's life, as the window's: never stopped. What a press landed on is
 * looked up the moment the page hears of it, before a scroll could move another visual there
 * (SPEC-0007, MV1 details).
 *
 * @sideEffects May start listening to the desktop shell.
 * @param listen - The shell's press listener.
 * @param clock - The UI's clock, for when each press came.
 * @returns The presses.
 */
function windowPresses(
  listen: (listener: (point: { x: number; y: number }) => void) => () => void,
  clock: UiClock,
): VisualPresses<Element> {
  if (presses === null) {
    const heard = new VisualPresses<Element>();
    presses = heard;
    listen((point) => heard.pressed(document.elementFromPoint(point.x, point.y), clock.now()));
  }
  return presses;
}

/**
 * What a session's replies may do with their visuals, through the client and the desktop shell.
 *
 * @remarks
 * SPEC-0007: resolving and sending go to the host; changes are this session's only; snapshots
 * need the desktop shell's capture, which a page outside the app has not; a path opens in a
 * viewer tab only when the workspace's opener takes it.
 *
 * @sideEffects none until used; then sends commands, listens to the client and captures the page.
 * @param client - The client.
 * @param sessionId - The session.
 * @param open - The workspace's file opener, if the session has a workspace.
 * @param clock - The UI's clock, for when presses came.
 * @returns The access.
 */
export function visualsAccess(
  client: AtriumClient,
  sessionId: string,
  open: FileOpener | undefined,
  clock: UiClock,
): VisualsAccess {
  const bridge = desktopBridge();
  const listen = bridge?.onPointerDown;
  const heard = listen === undefined ? null : windowPresses(listen, clock);
  return {
    sessionId,
    resolve: (path) => client.resolveVisual(sessionId, path),
    hold: (path) => client.holdVisual(sessionId, path),
    send: (path, text) => client.sendVisualMessage(sessionId, path, text),
    onChanged: (listener) =>
      client.onVisualChanged((changed) => {
        if (changed.sessionId === sessionId) listener(changed.path);
      }),
    capture: bridge?.captureVisual === undefined ? null : async (rect) => (await bridge.captureVisual?.(rect)) ?? null,
    presses:
      heard === null
        ? null
        : { has: (frame) => heard.has(frame, clock.now()), spend: (frame) => heard.spend(frame, clock.now()) },
    open: open === undefined ? null : (path) => open(path),
  };
}
