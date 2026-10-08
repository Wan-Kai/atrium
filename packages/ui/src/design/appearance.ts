/** The part of `MediaQueryList` the appearance watcher uses. */
export interface ColorSchemeQuery {
  readonly matches: boolean;
  addEventListener(type: "change", listener: (event: { matches: boolean }) => void): void;
  removeEventListener(type: "change", listener: (event: { matches: boolean }) => void): void;
}

/**
 * Keeps the `dark` class on an element in step with the system color scheme.
 *
 * @remarks
 * The default appearance is "follow system" (SPEC-0001, "界面"); dark tokens apply under `.dark`
 * (tokens.css). `applyAppearance` runs it only while the user's choice is to follow the system.
 *
 * @sideEffects Adds or removes the `dark` class on `root` now and on every system change;
 * registers a listener on `query` until the returned function is called.
 * @param root - Element that carries the class, normally `<html>`.
 * @param query - Result of `matchMedia("(prefers-color-scheme: dark)")`.
 * @returns A function that stops watching.
 */
export function followSystemAppearance(root: Element, query: ColorSchemeQuery): () => void {
  /**
   * Mirrors one system change onto the root element.
   *
   * @remarks
   * Kept as a named function so the same reference can be removed again on dispose.
   *
   * @sideEffects Toggles the `dark` class on `root`.
   * @param event - The media query change.
   */
  function onChange(event: { matches: boolean }): void {
    root.classList.toggle("dark", event.matches);
  }
  root.classList.toggle("dark", query.matches);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

/**
 * Applies the appearance the user chose: always light, always dark, or following the system.
 *
 * @remarks
 * The sidebar's switch (SPEC-0001, "界面"); only "system" keeps watching the system's scheme.
 *
 * @sideEffects Sets the `dark` class on `root`; for "system", watches `query` until stopped.
 * @param root - Element that carries the class, normally `<html>`.
 * @param query - Result of `matchMedia("(prefers-color-scheme: dark)")`.
 * @param appearance - The user's choice.
 * @returns A function that stops watching.
 */
export function applyAppearance(
  root: Element,
  query: ColorSchemeQuery,
  appearance: "system" | "light" | "dark",
): () => void {
  if (appearance === "system") return followSystemAppearance(root, query);
  root.classList.toggle("dark", appearance === "dark");
  return () => undefined;
}
