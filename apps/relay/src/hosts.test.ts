import { createTempDir, FakeClock } from "@atrium/testkit";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import {
  type HostRecord,
  HOST_ID,
  hashToken,
  hostsPath,
  newCredentials,
  readHosts,
  watchHosts,
  writeHosts,
} from "./hosts";
import { ResourceTracker } from "./resources";

const record: HostRecord = {
  hostId: "hst_0123456789abcdef",
  name: "Mac",
  tokenSha256: hashToken("token"),
  createdAt: "2026-10-25T00:00:00.000Z",
};

/**
 * A temporary data directory, removed after the test.
 *
 * @remarks
 * Each test gets its own.
 *
 * @sideEffects Creates a directory.
 * @returns Its path.
 */
async function tempDir(): Promise<string> {
  const dir = await createTempDir("relay-hosts");
  onTestFinished(dir.cleanup);
  return dir.path;
}

describe("host credentials", () => {
  it("makes hst_<16hex> ids and 32-byte base64url tokens, different each time", () => {
    const first = newCredentials();
    const second = newCredentials();

    expect(first.hostId).toMatch(HOST_ID);
    expect(first.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second.hostId).not.toBe(first.hostId);
    expect(second.token).not.toBe(first.token);
  });

  it("accepts only hst_ and exactly 16 lower-case hex digits as a host id", () => {
    const valid = "hst_0123456789abcdef";

    expect([valid, `x${valid}`, `${valid}0`, "hst_0123456789ABCDEF"].map((id) => HOST_ID.test(id))).toStrictEqual([
      true,
      false,
      false,
      false,
    ]);
  });

  it("hashes a token with SHA-256", () => {
    expect(hashToken("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("host table", () => {
  it("reads a missing table as empty", async () => {
    expect(await readHosts(await tempDir())).toStrictEqual({ ok: true, hosts: [] });
  });

  it("writes atomically as a 0600 file and reads it back", async () => {
    const dir = await tempDir();

    await writeHosts(dir, [record]);

    expect(await readHosts(dir)).toStrictEqual({ ok: true, hosts: [record] });
    expect((await stat(hostsPath(dir))).mode & 0o777).toBe(0o600);
    expect(await readdir(dir)).toStrictEqual(["hosts.json"]);
  });

  it("creates the data directory 0700 when missing", async () => {
    const dir = join(await tempDir(), "data");

    await writeHosts(dir, []);

    expect((await stat(dir)).mode & 0o777).toBe(0o700);
  });

  it.each([
    ["not JSON", "{"],
    ["another version", JSON.stringify({ version: 2, hosts: [] })],
    ["a bad host id", JSON.stringify({ version: 1, hosts: [{ ...record, hostId: "mac" }] })],
    ["a stored token", JSON.stringify({ version: 1, hosts: [{ ...record, token: "x" }] })],
    [
      "a hash with a prefix",
      JSON.stringify({ version: 1, hosts: [{ ...record, tokenSha256: `x${record.tokenSha256}` }] }),
    ],
    ["a hash too long", JSON.stringify({ version: 1, hosts: [{ ...record, tokenSha256: `${record.tokenSha256}0` }] })],
  ])("refuses a table with %s", async (_name, text) => {
    const dir = await tempDir();
    await writeFile(hostsPath(dir), text);

    expect(await readHosts(dir)).toStrictEqual({ ok: false });
  });

  it("throws when the table cannot be read for another reason", async () => {
    const dir = await tempDir();
    await mkdir(hostsPath(dir));

    await expect(readHosts(dir)).rejects.toThrow("EISDIR");
  });

  it("leaves no temporary file when the rename fails", async () => {
    const dir = await tempDir();
    await mkdir(join(hostsPath(dir), "occupied"), { recursive: true });

    await expect(writeHosts(dir, [record])).rejects.toThrow(/EISDIR|ENOTEMPTY|EEXIST/);

    expect((await readdir(dir)).toSorted()).toStrictEqual(["hosts.json"]);
  });
});

describe("watchHosts", () => {
  it("reports the table at once, then each change, and the invalid ones separately", async () => {
    const dir = await tempDir();
    const clock = new FakeClock();
    const resources = new ResourceTracker();
    const seen: HostRecord[][] = [];
    let invalid = 0;
    const stop = watchHosts(
      dir,
      clock,
      resources,
      (hosts) => seen.push(hosts),
      () => (invalid += 1),
      2_000,
    );
    onTestFinished(stop);
    await vi.waitFor(() => expect(seen).toStrictEqual([[]]));

    await writeHosts(dir, [record]);
    clock.advance(2_000);
    await vi.waitFor(() => expect(seen).toStrictEqual([[], [record]]));
    await writeFile(hostsPath(dir), "{");
    clock.advance(2_000);
    await vi.waitFor(() => expect(invalid).toBe(1));
    await writeHosts(dir, []);
    clock.advance(2_000);

    await vi.waitFor(() => expect(seen).toStrictEqual([[], [record], []]));
    expect(invalid).toBe(1);
  });

  it("does not report a table that did not change", async () => {
    const dir = await tempDir();
    await writeHosts(dir, [record]);
    const clock = new FakeClock();
    const seen: HostRecord[][] = [];
    const stop = watchHosts(
      dir,
      clock,
      new ResourceTracker(),
      (hosts) => seen.push(hosts),
      () => {},
      2_000,
    );
    onTestFinished(stop);
    await vi.waitFor(() => expect(seen).toHaveLength(1));

    for (let round = 0; round < 3; round += 1) {
      clock.advance(2_000);
      await vi.waitFor(() => expect(clock.pendingTimers()).toBe(1));
    }

    expect(seen).toStrictEqual([[record]]);
  });

  it("reports an unreadable table as invalid", async () => {
    const dir = await tempDir();
    await mkdir(hostsPath(dir));
    let invalid = 0;

    const stop = watchHosts(
      dir,
      new FakeClock(),
      new ResourceTracker(),
      () => {},
      () => (invalid += 1),
      2_000,
    );
    onTestFinished(stop);

    await vi.waitFor(() => expect(invalid).toBe(1));
  });

  it("stops polling and holds no timer once stopped", async () => {
    const dir = await tempDir();
    const clock = new FakeClock();
    const resources = new ResourceTracker();
    const seen: HostRecord[][] = [];
    const stop = watchHosts(
      dir,
      clock,
      resources,
      (hosts) => seen.push(hosts),
      () => {},
      2_000,
    );
    await vi.waitFor(() => expect(clock.pendingTimers()).toBe(1));

    stop();
    await writeHosts(dir, [record]);
    clock.advance(10_000);

    expect(clock.pendingTimers()).toBe(0);
    expect(resources.snapshot()).toStrictEqual({ timer: 0 });
    expect(seen).toStrictEqual([[]]);
  });

  it("reports no invalid table from a poll still running when stopped", async () => {
    const dir = await tempDir();
    await writeFile(hostsPath(dir), "{");
    let invalid = 0;

    const stop = watchHosts(
      dir,
      new FakeClock(),
      new ResourceTracker(),
      () => {},
      () => (invalid += 1),
      2_000,
    );
    stop();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(invalid).toBe(0);
  });

  it("reports nothing from a poll still running when stopped", async () => {
    const dir = await tempDir();
    await writeHosts(dir, [record]);
    const clock = new FakeClock();
    const seen: HostRecord[][] = [];

    const stop = watchHosts(
      dir,
      clock,
      new ResourceTracker(),
      (hosts) => seen.push(hosts),
      () => {},
      2_000,
    );
    stop();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(seen).toStrictEqual([]);
    expect(clock.pendingTimers()).toBe(0);
  });
});
