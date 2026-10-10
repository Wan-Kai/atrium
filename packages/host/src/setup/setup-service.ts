import { MIN_PI_VERSION, type NodeInspection, type PiInspection, type Version } from "@atrium/pi";
import type { PiLatest, SetupNode, SetupPi, SetupState } from "@atrium/protocol";
import type { Logins } from "./logins";
import type { Toolbox } from "./toolbox";

/** First launch's checks. */
export interface SetupService {
  /** Checks pi, Node, Homebrew, fd, the logins and the projects; `refresh` detects the tools again first. */
  check(refresh: boolean): Promise<SetupState>;
}

/**
 * Writes a version the way the protocol carries it.
 *
 * @remarks
 * `major.minor.patch`, as pi and Node print theirs.
 *
 * @sideEffects none
 * @param version - The version.
 * @returns The text.
 */
function versionText(version: Version): string {
  return version.join(".");
}

/**
 * pi as first launch shows it.
 *
 * @remarks
 * A pi that is there but does not run is `broken`, with its own error output (SPEC-0001, "首次启动 ·
 * 接口"). No tools at all, when detection failed, reads as no pi.
 *
 * @sideEffects none
 * @param pi - What detection found, if it ran.
 * @returns The protocol's pi, but for the latest pi found.
 */
function setupPi(pi: PiInspection | undefined): Omit<SetupPi, keyof PiLatest> {
  const minimum = versionText(MIN_PI_VERSION);
  if (pi === undefined || pi.status === "missing") {
    return { state: "missing", path: null, version: null, minimum, detail: null };
  }
  if (pi.status === "unusable") return { state: "broken", path: pi.piPath, version: null, minimum, detail: pi.detail };
  return { state: pi.status, path: pi.piPath, version: versionText(pi.version), minimum, detail: null };
}

/**
 * Node as first launch shows it.
 *
 * @remarks
 * No tools at all reads as no Node.
 *
 * @sideEffects none
 * @param node - What detection found, if it ran.
 * @returns The protocol's Node.
 */
function setupNode(node: NodeInspection | undefined): SetupNode {
  if (node === undefined || node.status === "missing") return { state: "missing", version: null };
  return { state: node.status, version: versionText(node.version) };
}

/**
 * Creates first launch's checks.
 *
 * @remarks
 * After installing pi or Node, first launch asks with `refresh`, which reads the login shell again
 * (SPEC-0001, "首次启动 · 接口"). The logins are checked each time: they change in the terminal too.
 *
 * @sideEffects none until asked; then may detect the tools again and runs the login program.
 * @param options - The toolbox, the logins, the number of projects added, and the latest pi found.
 * @returns The service.
 */
export function createSetupService(options: {
  readonly toolbox: Pick<Toolbox, "current" | "refresh">;
  readonly logins: Pick<Logins, "status">;
  readonly projects: () => number;
  readonly latest: () => PiLatest;
}): SetupService {
  return {
    check: async (refresh) => {
      const tools = await (refresh ? options.toolbox.refresh() : options.toolbox.current());
      return {
        pi: { ...setupPi(tools?.pi), ...options.latest() },
        node: setupNode(tools?.node),
        homebrew: (tools?.homebrew ?? null) !== null,
        fd: (tools?.fd ?? null) !== null,
        login: await options.logins.status(tools),
        projects: options.projects(),
      };
    },
  };
}
