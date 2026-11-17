import { describe, expect, it } from "vitest";
import { createScreen } from "./screen";

describe("createScreen", () => {
  it("reads back what the program printed, without escape sequences", async () => {
    const screen = createScreen(40, 10);
    screen.write("\u001b[32mhello\u001b[0m\r\nworld\r\n");
    const reading = await screen.read();
    expect(reading.text).toContain("hello");
    expect(reading.text).toContain("world");
    expect(reading.text).not.toContain("\u001b");
    expect([reading.cols, reading.rows]).toStrictEqual([40, 10]);
  });

  it("reports the cursor where the program left it", async () => {
    const screen = createScreen(40, 10);
    screen.write("abc");
    const reading = await screen.read();
    expect(reading.cursor).toStrictEqual({ row: 0, col: 3 });
  });

  it("keeps the last lines when asked for fewer", async () => {
    const screen = createScreen(40, 10);
    screen.write("one\r\ntwo\r\nthree\r\n");
    const reading = await screen.read(2);
    expect(reading.text.split("\n")).toStrictEqual(["two", "three"]);
  });

  it("follows a resize", async () => {
    const screen = createScreen(40, 10);
    screen.resize(100, 30);
    const reading = await screen.read();
    expect([reading.cols, reading.rows]).toStrictEqual([100, 30]);
  });
});
