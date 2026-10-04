import { describe, expect, it } from "vitest";
import { type ColorSchemeQuery, followSystemAppearance } from "./appearance";

/** A color-scheme query whose value the test can flip, standing in for the OS setting. */
function systemScheme(initiallyDark: boolean) {
  const listeners = new Set<(event: { matches: boolean }) => void>();
  const query: ColorSchemeQuery & { flip(dark: boolean): void; listenerCount(): number } = {
    matches: initiallyDark,
    addEventListener: (_type, listener) => listeners.add(listener),
    removeEventListener: (_type, listener) => listeners.delete(listener),
    flip: (dark) => {
      for (const listener of listeners) listener({ matches: dark });
    },
    listenerCount: () => listeners.size,
  };
  return query;
}

describe("followSystemAppearance", () => {
  it("applies the current scheme, follows changes, and stops following when disposed", () => {
    const root = document.createElement("html");
    const scheme = systemScheme(true);

    const stop = followSystemAppearance(root, scheme);
    expect(root.classList.contains("dark")).toBe(true);
    scheme.flip(false);
    expect(root.classList.contains("dark")).toBe(false);
    stop();
    scheme.flip(true);

    expect(root.classList.contains("dark")).toBe(false);
    expect(scheme.listenerCount()).toBe(0);
  });
});
