import { FakeClock, createTempDir } from "@atrium/testkit";
import { describe, expect, it, onTestFinished } from "vitest";
import { loadIndexFile } from "../store/index-file";
import { LAYOUTS_FILE } from "../store/index-schema";
import { KEPT_CLIENTS, createLayouts } from "./layouts";

const A = "wks_000000000000000a";
const B = "wks_000000000000000b";

/**
 * Layouts over a fresh index.
 *
 * @remarks
 * The clock moves one millisecond per change, so clients are seen in order.
 *
 * @sideEffects Creates the index directory.
 * @returns The layouts, the file and the clock.
 */
async function layouts() {
  const index = await createTempDir("layouts");
  onTestFinished(index.cleanup);
  const { file } = await loadIndexFile(index.path, LAYOUTS_FILE, 0);
  const clock = new FakeClock(1_000);
  return { layouts: createLayouts({ file, clock }), file, clock };
}

describe("Layouts", () => {
  it("gives a client never seen an empty layout", async () => {
    const { layouts: all } = await layouts();

    expect(all.of("c1")).toStrictEqual({ container: null, tabs: {} });
  });

  it("opens sessions as tabs in order, activates the one opened, and goes to its container", async () => {
    const { layouts: all, file } = await layouts();

    await all.open("c1", A, "s1");
    await all.open("c1", A, "s2");
    await all.open("c1", A, "s1");
    await all.open("c1", B, "s3");

    expect(all.of("c1")).toStrictEqual({
      container: B,
      tabs: { [A]: { open: ["s1", "s2"], active: "s1" }, [B]: { open: ["s3"], active: "s3" } },
    });
    expect(file.read().clients).toMatchObject([{ clientId: "c1", seenAt: 1_000 }]);
  });

  it("keeps each client's layout apart", async () => {
    const { layouts: all } = await layouts();

    await all.open("c1", A, "s1");
    await all.open("c2", A, "s2");
    await all.close("c1", "s2");

    expect(all.of("c1").tabs).toStrictEqual({ [A]: { open: ["s1"], active: "s1" } });
    expect(all.of("c2").tabs).toStrictEqual({ [A]: { open: ["s2"], active: "s2" } });
  });

  it("activates the tab to the right of a closed active tab, else the one to its left", async () => {
    const { layouts: all } = await layouts();
    for (const id of ["s1", "s2", "s3"]) await all.open("c1", A, id);
    await all.open("c1", A, "s2");

    await all.close("c1", "s2");
    expect(all.of("c1").tabs[A]).toStrictEqual({ open: ["s1", "s3"], active: "s3" });
    await all.close("c1", "s3");
    expect(all.of("c1").tabs[A]).toStrictEqual({ open: ["s1"], active: "s1" });
    await all.close("c1", "s1");
    expect(all.of("c1").tabs[A]).toStrictEqual({ open: [], active: null });
  });

  it("leaves the active tab when another tab closes, and ignores a tab not open", async () => {
    const { layouts: all } = await layouts();
    await all.open("c1", A, "s1");
    await all.open("c1", A, "s2");

    await all.close("c1", "s1");
    await all.close("c1", "s9");

    expect(all.of("c1").tabs[A]).toStrictEqual({ open: ["s2"], active: "s2" });
  });

  it("goes to a container or nowhere", async () => {
    const { layouts: all } = await layouts();

    await all.select("c1", "chats");
    expect(all.of("c1").container).toBe("chats");
    await all.select("c1", null);
    expect(all.of("c1")).toStrictEqual({ container: null, tabs: {} });
  });

  it("closes a session's tabs in every client, writing only when something changed", async () => {
    const { layouts: all, file, clock } = await layouts();
    await all.open("c1", A, "s1");
    await all.open("c2", B, "s1");
    await all.open("c2", B, "s2");
    const before = file.read();

    await all.forgetSessions(["s9"]);
    expect(file.read()).toBe(before);
    clock.advance(5);
    await all.forgetSessions(["s1"]);

    expect([all.of("c1").tabs, all.of("c2").tabs]).toStrictEqual([
      { [A]: { open: [], active: null } },
      { [B]: { open: ["s2"], active: "s2" } },
    ]);
    expect(file.read().clients.map((client) => client.seenAt)).toStrictEqual([1_000, 1_000]);
  });

  it("drops containers that went away, leaving them if a client is there", async () => {
    const { layouts: all } = await layouts();
    await all.open("c1", A, "s1");
    await all.open("c1", B, "s2");
    await all.open("c2", A, "s3");
    await all.select("c2", "chats");

    await all.forgetContainers([B]);

    expect(all.of("c1")).toStrictEqual({ container: null, tabs: { [A]: { open: ["s1"], active: "s1" } } });
    expect(all.of("c2")).toStrictEqual({ container: "chats", tabs: { [A]: { open: ["s3"], active: "s3" } } });
  });

  it("tells whether any client has a session open", async () => {
    const { layouts: all } = await layouts();
    await all.open("c1", A, "s1");

    expect(all.isOpen("s1")).toBe(true);
    expect(all.isOpen("s2")).toBe(false);
  });

  it(`keeps the ${KEPT_CLIENTS} clients seen most recently`, async () => {
    const { layouts: all, clock } = await layouts();

    for (let index = 0; index <= KEPT_CLIENTS; index += 1) {
      await all.select(`c${index}`, "chats");
      clock.advance(1);
    }
    await all.select("c1", "chats");
    clock.advance(1);
    await all.select("new", "chats");

    expect(all.of("c0").container).toBeNull();
    expect(all.of("c1").container).toBe("chats");
    expect(all.of("c2").container).toBeNull();
    expect(all.of("new").container).toBe("chats");
  });
});
