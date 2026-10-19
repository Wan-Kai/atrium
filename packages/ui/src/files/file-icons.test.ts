import { describe, expect, it } from "vitest";
import { fileIconName } from "./file-icons";

describe("fileIconName", () => {
  it("knows a file by its whole name first, ignoring case and the directory", () => {
    expect(
      ["package.json", "src/Makefile", "PNPM-LOCK.YAML", ".gitignore", "tsconfig.json", "README.md"].map((path) =>
        fileIconName(path, false),
      ),
    ).toStrictEqual(["nodejs", "makefile", "pnpm", "git", "tsconfig", "readme"]);
  });

  it("then by its longest extension, a leading dot starting one too", () => {
    expect(
      ["a.ts", "src/panes.test.ts", "types.d.ts", "App.TSX", "logo.png", ".env", "a.b.c.md"].map((path) =>
        fileIconName(path, false),
      ),
    ).toStrictEqual(["typescript", "test-ts", "typescript-def", "react_ts", "image", "tune", "markdown"]);
  });

  it("gives the plain file icon to a name it does not know, without a dot or with nothing after it, nor by an object's own members", () => {
    expect(
      ["notes.zzz", "LICENSE-x", "xts", "trailing.", "", "src/", "constructor", "a.__proto__", "a.constructor"].map(
        (path) => fileIconName(path, false),
      ),
    ).toStrictEqual(["file", "file", "file", "file", "file", "file", "file", "file", "file"]);
  });

  it("takes the light variant in the light appearance wherever there is one, by name or extension", () => {
    expect(
      ["pnpm-lock.yaml", ".autorc", "a.cr", "a.ts"].map((path) => [
        fileIconName(path, true),
        fileIconName(path, false),
      ]),
    ).toStrictEqual([
      ["pnpm_light", "pnpm"],
      ["auto_light", "auto"],
      ["crystal_light", "crystal"],
      ["typescript", "typescript"],
    ]);
  });

  it("keeps a name's icon in the light appearance over its extension's light variant", () => {
    expect([fileIconName(".babelrc.toml", true), fileIconName("a.toml", true)]).toStrictEqual(["babel", "toml_light"]);
  });
});
