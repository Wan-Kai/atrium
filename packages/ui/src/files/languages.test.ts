import { bundledLanguagesInfo } from "shiki/langs";
import { describe, expect, it } from "vitest";
import { languageOf } from "./languages";

describe("languageOf", () => {
  it("knows a language by Shiki's names and aliases for the extension, ignoring case", () => {
    expect(
      ["src/a.ts", "b.TSX", "c.mjs", "d.py", "e.yml", "f.rs", "README.md", "g.sh", "h.json", "env.d.ts"].map((path) =>
        languageOf(path, bundledLanguagesInfo),
      ),
    ).toStrictEqual([
      "typescript",
      "tsx",
      "javascript",
      "python",
      "yaml",
      "rust",
      "markdown",
      "shellscript",
      "json",
      "typescript",
    ]);
  });

  it("knows the names and extensions Shiki does not, a leading dot starting one", () => {
    const known = {
      Dockerfile: "docker",
      "src/Makefile": "make",
      GNUmakefile: "make",
      "CMakeLists.txt": "cmake",
      Gemfile: "ruby",
      Rakefile: "ruby",
      Podfile: "ruby",
      justfile: "just",
      "a.h": "c",
      "b.hpp": "cpp",
      "b.hh": "cpp",
      "b.cc": "cpp",
      "b.cxx": "cpp",
      "c.m": "objective-c",
      "c.mm": "objective-cpp",
      "x.ex": "elixir",
      "x.exs": "elixir",
      "y.ml": "ocaml",
      "y.mli": "ocaml",
      "page.htm": "html",
      "icon.svg": "xml",
      "stub.pyi": "python",
      "rules.mk": "make",
      ".env": "dotenv",
      "token.sol": "solidity",
    };

    expect(
      Object.fromEntries(Object.keys(known).map((path) => [path, languageOf(path, bundledLanguagesInfo)])),
    ).toStrictEqual(known);
  });

  it("knows none for a file without an extension, or one no language has, nor by an object's own members", () => {
    expect(
      [
        "LICENSE",
        "notes.txt",
        "a.lock",
        "dir.d/plain",
        "bin/python",
        "constructor",
        "a.constructor",
        "a.__proto__",
      ].map((path) => languageOf(path, bundledLanguagesInfo)),
    ).toStrictEqual([null, null, null, null, null, null, null, null]);
  });
});
