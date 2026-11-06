import { FakeClock, createTempDir } from "@atrium/testkit";
import { describe, expect, it, onTestFinished } from "vitest";
import { createLayouts } from "../sessions/layouts";
import { loadIndexFile } from "../store/index-file";
import { layoutsFile } from "../store/index-schema";
import { withEntries } from "./entering";

describe("withEntries", () => {
  it("tells of a client going into a container by selecting it or opening a session that takes it there", async () => {
    const index = await createTempDir("entering");
    onTestFinished(index.cleanup);
    const layouts = createLayouts({
      file: (await loadIndexFile(index.path, layoutsFile({ sessions: [] }), 0)).file,
      clock: new FakeClock(),
    });
    const entered: (string | null)[] = [];
    const wrapped = withEntries(layouts, (containerId) => entered.push(containerId));

    await wrapped.select("c1", "lrn_go");
    await wrapped.open("c1", "lrn_rust", "s1");
    await wrapped.open("c1", "lrn_sql", "s2", false);
    await wrapped.select("c1", null);

    expect(entered).toStrictEqual(["lrn_go", "lrn_rust", null]);
    expect(wrapped.of("c1")).toStrictEqual({
      container: null,
      tabs: { lrn_rust: { open: ["s1"], active: "s1" }, lrn_sql: { open: ["s2"], active: "s2" } },
    });
    expect(wrapped.isOpen("s2")).toBe(true);
  });
});
