import { describe, expect, it } from "vitest";
import { replyImageSource } from "./reply-image-source";

const root = "/work/example";

describe("reply image paths", () => {
  it("resolves relative, absolute and file paths only inside the workspace", () => {
    expect(
      ["./images/a.png", "images/a.png", "/work/example/images/a.png", "file:///work/example/images/a.png"].map(
        (source) => replyImageSource(source, root),
      ),
    ).toStrictEqual(Array.from({ length: 4 }, () => ({ kind: "local", path: "images/a.png" })));
    expect(replyImageSource("images/%E5%9B%BE%20a.png", root)).toStrictEqual({
      kind: "local",
      path: "images/图 a.png",
    });
  });

  it.each([
    "../secret.png",
    "images/../secret.png",
    "%2e%2e/secret.png",
    "/work/example-other/a.png",
    "file:///work/secret.png",
    "file://remote/work/example/a.png",
    "~/a.png",
    "javascript:alert(1)",
    "blob:https://example.com/id",
    "data:image/svg+xml,<svg/>",
    "file:///work/example/../secret.png",
    "bad%",
    "a%00.png",
    "a%2fb.png",
    "https://user:pass@example.com/a.png",
    "//example.com/a.png",
    "https://example.com/a\n.png",
    "https://example.com/a\\b.png",
    "https://user@example.com/a.png",
    "https://:pass@example.com/a.png",
    "https://",
    "data:image/png;base64,AAAA!",
    "xdata:image/png;base64,AAAA",
    "file:///work/example/a.png?query",
    "file:///work/example/a.png#part",
    "file:file:///work/example/a.png",
    "",
    ".",
    "/",
    "./",
  ])("rejects unsafe source %s", (source) => {
    expect(replyImageSource(source, root)).toStrictEqual({ kind: "blocked" });
  });

  it("keeps allowed raster data addresses without involving the filesystem", () => {
    expect(
      [
        "data:image/png;base64,AAAA",
        "data:image/jpeg;base64,AAA=",
        "data:image/gif;base64,AA==",
        "data:image/webp;base64,AAAA",
      ].map((src) => replyImageSource(src, null)),
    ).toStrictEqual([
      { kind: "remote", src: "data:image/png;base64,AAAA" },
      { kind: "remote", src: "data:image/jpeg;base64,AAA=" },
      { kind: "remote", src: "data:image/gif;base64,AA==" },
      { kind: "remote", src: "data:image/webp;base64,AAAA" },
    ]);
  });

  it("normalizes empty segments and roots with trailing slashes without treating a filename's colon as a scheme", () => {
    expect(replyImageSource("images//a.png", root)).toStrictEqual({ kind: "local", path: "images/a.png" });
    expect(replyImageSource("/work/example/a.png", `${root}///`)).toStrictEqual({ kind: "local", path: "a.png" });
    expect(replyImageSource("docs/file:example.png", root)).toStrictEqual({
      kind: "local",
      path: "docs/file:example.png",
    });
    expect(replyImageSource("//work/example/a.png", "/")).toStrictEqual({ kind: "blocked" });
    expect(replyImageSource("file://localhost/work/example/a.png", root)).toStrictEqual({
      kind: "local",
      path: "a.png",
    });
  });

  it("accepts 4096 path characters but rejects longer ones", () => {
    expect(replyImageSource("a".repeat(4096), root)).toStrictEqual({ kind: "local", path: "a".repeat(4096) });
    expect(replyImageSource("a".repeat(4097), root)).toStrictEqual({ kind: "blocked" });
  });

  it("does not read local files without a workspace, but retains the https/http distinction", () => {
    expect(replyImageSource("a.png", null)).toStrictEqual({ kind: "blocked" });
    expect(replyImageSource("https://example.com/a.png", null)).toStrictEqual({
      kind: "remote",
      src: "https://example.com/a.png",
    });
    expect(replyImageSource("http://example.com/a.png", root)).toStrictEqual({
      kind: "link",
      src: "http://example.com/a.png",
    });
  });
});
