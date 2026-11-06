import { describe, expect, it } from "vitest";
import { isRelativeVisual, parseVisualReference } from "./visual-reference";

describe("parseVisualReference", () => {
  it("reads the path and an optional title of a visual block", () => {
    expect(parseVisualReference('{"path":"visuals/2-03-isolation.html"}\n')).toStrictEqual({
      path: "visuals/2-03-isolation.html",
      title: null,
    });
    expect(parseVisualReference(' {"path":"/v/a.html","title":"隔离级别"} ')).toStrictEqual({
      path: "/v/a.html",
      title: "隔离级别",
    });
  });

  it.each([
    [""],
    ["not json"],
    ['"a.html"'],
    ["[]"],
    ["null"],
    ['{"path":""}'],
    ['{"path":1}'],
    ['{"title":"x"}'],
    ['{"path":"a.html","title":2}'],
    [`{"path":"${"a".repeat(4097)}"}`],
  ])("calls %j no reference", (code) => {
    expect(parseVisualReference(code)).toBeNull();
  });

  it("drops a blank title, and cuts a long one", () => {
    expect(parseVisualReference('{"path":"a.html","title":"  "}')?.title).toBeNull();
    expect(parseVisualReference(`{"path":"a.html","title":"${"长".repeat(300)}"}`)?.title).toHaveLength(200);
  });
});

describe("isRelativeVisual", () => {
  it("tells a path relative to the working directory from an absolute one", () => {
    expect([isRelativeVisual("visuals/a.html"), isRelativeVisual("/v/a.html")]).toStrictEqual([true, false]);
  });
});
