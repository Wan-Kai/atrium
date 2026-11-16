import { describe, expect, it } from "vitest";
import { clockWords } from "./clock-words";

describe("the time a line or a card carries", () => {
  it("writes hours and minutes in 24 hours, with the leading zeros", () => {
    expect(clockWords(new Date(2026, 10, 6, 10, 44).getTime())).toBe("10:44");
    expect(clockWords(new Date(2026, 10, 6, 9, 5).getTime())).toBe("09:05");
    expect(clockWords(new Date(2026, 10, 6, 23, 59).getTime())).toBe("23:59");
  });
});
