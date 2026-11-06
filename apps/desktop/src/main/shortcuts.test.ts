import { describe, expect, it } from "vitest";
import { menuShortcut } from "./shortcuts";

describe("menuShortcut", () => {
  const key = { type: "keyDown", meta: true, control: false, alt: false, shift: false } as const;

  it("takes ⌘W and ⌘, only, pressed with the command key alone", () => {
    expect(
      [
        { ...key, key: "w" },
        { ...key, key: "W" },
        { ...key, key: "," },
        { ...key, key: "n" },
        { ...key, key: "w", type: "keyUp" },
        { ...key, key: "w", meta: false },
        { ...key, key: "w", control: true },
        { ...key, key: "w", alt: true },
        { ...key, key: ",", shift: true },
      ].map((input) => menuShortcut(input)),
    ).toStrictEqual(["close-tab", "close-tab", "settings", null, null, null, null, null, null]);
  });
});
