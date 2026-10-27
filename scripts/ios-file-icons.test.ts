import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
const script = join(root, "scripts", "ios-file-icons.mjs");
const output = join(root, "apps/ios/AtriumKit/Sources/AtriumUI/Resources/file-icons.json");

describe("ios-file-icons.mjs", () => {
  it("keeps the committed icons in step with the desktop's table", () => {
    const result = spawnSync(process.execPath, [script, "--check"], { encoding: "utf8" });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it("keeps only lookups whose icon can be drawn, and plain filled paths", () => {
    const table = JSON.parse(readFileSync(output, "utf8")) as {
      file: string;
      fileExtensions: Record<string, string>;
      icons: Record<string, { box: number[]; paths: { d: string; fill: string }[] }>;
    };
    expect(table.icons[table.file]?.paths.length).toBeGreaterThan(0);
    expect(table.fileExtensions["ts"]).toBe("typescript");
    expect(Object.values(table.fileExtensions).every((icon) => icon in table.icons)).toBe(true);
    expect(Object.values(table.icons).filter((icon) => icon.box.length !== 4)).toStrictEqual([]);
    expect(Object.values(table.icons).filter((icon) => icon.paths.length === 0)).toStrictEqual([]);
    // The <svg>'s own fill="none" is inherited: readme's background square is not drawn black.
    expect(table.icons["readme"]?.paths.map((path) => path.fill)).toStrictEqual(["#42a5f5"]);
    // windicss is a stroked wind shape and one filled square: not half drawn, left to the generic icon.
    expect(table.icons["windicss"]).toBeUndefined();
  });
});
