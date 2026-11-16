import type { ElectronApplication, FrameLocator } from "@playwright/test";

/**
 * Clicks the middle of an element inside a visual, with the press also seen by the app's main process.
 *
 * @remarks
 * Playwright's clicks go in over the debugging protocol and never reach `input-event`, so the
 * press Atrium binds a visual's message to would be missing. `sendInputEvent` does reach
 * `input-event`, but here never reaches the frame's own process. So the press goes in the real
 * way through the window first, then Playwright clicks the element.
 *
 * @sideEffects Sends a mouse press and release to the first window, then clicks the element.
 * @param app - The running app.
 * @param target - The element to click.
 */
export async function pressInWindow(
  app: ElectronApplication,
  target: ReturnType<FrameLocator["locator"]>,
): Promise<void> {
  const box = await target.boundingBox();
  if (box === null) throw new Error("the element has no box");
  const point = { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
  await app.evaluate(({ BrowserWindow }, at) => {
    const contents = BrowserWindow.getAllWindows()[0]?.webContents;
    contents?.sendInputEvent({ type: "mouseDown", x: at.x, y: at.y, button: "left", clickCount: 1 });
    contents?.sendInputEvent({ type: "mouseUp", x: at.x, y: at.y, button: "left", clickCount: 1 });
  }, point);
  await target.click();
}
