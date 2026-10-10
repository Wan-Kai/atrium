import type { Page } from "@playwright/test";

/**
 * Sends a message from the input box.
 *
 * @remarks
 * As the user does: type, then Enter.
 *
 * @sideEffects Types into the page.
 * @param window - The app's page.
 * @param text - The message.
 */
export async function send(window: Page, text: string): Promise<void> {
  const box = window.getByRole("textbox", { name: "消息" });
  await box.fill(text);
  await box.press("Enter");
}

/**
 * A sent message as its bubble reads: the text, then the time.
 *
 * @remarks
 * The time is the clock's, so only its shape is fixed.
 *
 * @sideEffects none
 * @param text - The message.
 * @returns The pattern.
 */
export function sentAs(text: string): RegExp {
  return new RegExp(`^${text}\\d{2}:\\d{2}$`);
}
