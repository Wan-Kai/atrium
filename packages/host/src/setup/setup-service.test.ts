import { PI_TEXT_MAX, type PiLatest, type SetupLogin } from "@atrium/protocol";
import { describe, expect, it } from "vitest";
import { createSetupService } from "./setup-service";
import type { HostTools } from "./toolbox";

const READY: HostTools = {
  env: { PATH: "/bin" },
  envSource: "login-shell",
  pi: { status: "ready", piPath: "/bin/pi", version: [1, 0, 2] },
  node: { status: "ready", nodePath: "/bin/node", version: [22, 19, 1] },
  homebrew: "/opt/homebrew/bin/brew",
  fd: "/bin/fd",
};

const LOGGED_IN: SetupLogin = {
  state: "ready",
  providers: [
    {
      providerId: "anthropic",
      name: "Anthropic",
      oauth: { label: "Anthropic (Claude Pro/Max)", subscription: true },
      apiKey: true,
      signedIn: { method: "oauth", stored: true },
    },
  ],
};

/** The latest pi the service is told was found. */
const LATEST = { latest: "1.1.0", checkedAt: 7 } as const;

/**
 * A setup service over tools a test sets.
 *
 * @remarks
 * The toolbox answers `current` with the first tools and `refresh` with the second, and records
 * which was asked; the logins record the tools they were asked about. A latest pi found while the
 * logins are checked, as happens at startup, replaces {@link LATEST}.
 *
 * @sideEffects none
 * @param current - What `current` gives.
 * @param refreshed - What `refresh` gives.
 * @param foundMeanwhile - The latest pi found while the logins are checked, if any.
 * @returns The service and what was asked.
 */
function service(current: HostTools | null, refreshed: HostTools | null = current, foundMeanwhile: PiLatest = LATEST) {
  let found: PiLatest = LATEST;
  const asked: string[] = [];
  const loginsAsked: (HostTools | null)[] = [];
  const value = createSetupService({
    toolbox: {
      current: async () => {
        asked.push("current");
        return current;
      },
      refresh: async () => {
        asked.push("refresh");
        return refreshed;
      },
    },
    logins: {
      status: async (tools) => {
        loginsAsked.push(tools);
        found = foundMeanwhile;
        return LOGGED_IN;
      },
    },
    projects: () => 3,
    latest: () => found,
  });
  return { value, asked, loginsAsked };
}

describe("SetupService.check", () => {
  it("reports ready tools, the logins and the projects", async () => {
    const { value, asked, loginsAsked } = service(READY);

    expect(await value.check(false)).toStrictEqual({
      pi: { state: "ready", path: "/bin/pi", version: "1.0.2", minimum: "1.0.1", detail: null, ...LATEST },
      node: { state: "ready", version: "22.19.1" },
      homebrew: true,
      fd: true,
      login: LOGGED_IN,
      projects: 3,
    });
    expect(asked).toStrictEqual(["current"]);
    expect(loginsAsked).toStrictEqual([READY]);
  });

  it("detects the tools again when asked to refresh, and reports what that found", async () => {
    const missing: HostTools = {
      ...READY,
      pi: { status: "missing" },
      node: { status: "missing" },
      homebrew: null,
      fd: null,
    };
    const { value, asked, loginsAsked } = service(missing, READY);

    expect((await value.check(true)).pi.state).toBe("ready");
    expect(asked).toStrictEqual(["refresh"]);
    expect(loginsAsked).toStrictEqual([READY]);
  });

  it("reports a missing pi and Node, and no Homebrew or fd", async () => {
    const { value } = service({
      ...READY,
      pi: { status: "missing" },
      node: { status: "missing" },
      homebrew: null,
      fd: null,
    });

    expect(await value.check(false)).toMatchObject({
      pi: { state: "missing", path: null, version: null, minimum: "1.0.1", detail: null, ...LATEST },
      node: { state: "missing", version: null },
      homebrew: false,
      fd: false,
    });
  });

  it("reports a pi that does not run as broken, with its words, and an old pi and Node as outdated", async () => {
    const broken = service({
      ...READY,
      pi: { status: "unusable", piPath: "/bin/pi", detail: "env: node: No such file" },
    });
    const old = service({
      ...READY,
      pi: { status: "outdated", piPath: "/bin/pi", version: [0, 9, 3], minimum: [1, 0, 1] },
      node: { status: "outdated", nodePath: "/bin/node", version: [20, 11, 0] },
    });

    expect((await broken.value.check(false)).pi).toStrictEqual({
      state: "broken",
      path: "/bin/pi",
      version: null,
      minimum: "1.0.1",
      detail: "env: node: No such file",
      ...LATEST,
    });
    expect(await old.value.check(false)).toMatchObject({
      pi: { state: "outdated", path: "/bin/pi", version: "0.9.3", minimum: "1.0.1", detail: null, ...LATEST },
      node: { state: "outdated", version: "20.11.0" },
    });
  });

  it("reports the latest pi found while it checked the logins", async () => {
    const later = { latest: "1.2.0", checkedAt: 8 };
    const { value } = service(READY, READY, later);

    expect((await value.check(false)).pi).toMatchObject(later);
  });

  it("cuts pi's error output to what the protocol carries", async () => {
    const { value } = service({ ...READY, pi: { status: "unusable", piPath: "/bin/pi", detail: "e".repeat(20_000) } });

    expect((await value.check(false)).pi.detail).toBe("e".repeat(PI_TEXT_MAX));
  });

  it("reports nothing found when detection failed", async () => {
    const { value, loginsAsked } = service(null);

    expect(await value.check(false)).toStrictEqual({
      pi: { state: "missing", path: null, version: null, minimum: "1.0.1", detail: null, ...LATEST },
      node: { state: "missing", version: null },
      homebrew: false,
      fd: false,
      login: LOGGED_IN,
      projects: 3,
    });
    expect(loginsAsked).toStrictEqual([null]);
  });
});
