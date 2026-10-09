import { type FauxScript, fauxPi } from "@atrium/testkit";
import { access, chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

/** Environment for `launchApp` that makes the host's pi answer from a faux script, and its cleanup. */
export interface FauxPiEnvironment {
  readonly env: Record<string, string>;
  /** pi's agent directory, where it keeps its settings and session files. */
  readonly agentDir: string;
  /** Lets replies scripted with `waitFor: name` continue. */
  readonly release: (name: string) => Promise<void>;
  /** The process id of the pi the host started last. */
  readonly pid: () => Promise<number>;
  readonly cleanup: () => Promise<void>;
}

/**
 * Finds the real pi on this process's PATH.
 *
 * @remarks
 * End-to-end tests run the pi that is installed, as the host would, only answering from the faux
 * model instead of a real one.
 *
 * @sideEffects Checks files on disk.
 * @returns The path of `pi`.
 * @throws {Error} When pi is not installed.
 */
async function realPi(): Promise<string> {
  for (const directory of (process.env["PATH"] ?? "").split(delimiter)) {
    const candidate = join(directory, "pi");
    if (
      directory !== "" &&
      (await access(candidate).then(
        () => true,
        () => false,
      ))
    )
      return candidate;
  }
  throw new Error("pi is not on PATH; end-to-end chat tests need it installed");
}

/**
 * Prepares an environment in which the host's pi answers from `script`.
 *
 * @remarks
 * The host reads its tools from the login shell; a `SHELL` it does not support makes it use its own
 * environment instead (SPEC-0001, "第 1 步"), which `launchApp` controls. A `pi` wrapper first on
 * PATH runs the real pi with the faux extension (testing.md, "faux 模型") and passes `--version`
 * straight through, so the host finds and checks it as it would the real one. Variable names avoid
 * `ATRIUM_`, which the host keeps from pi.
 *
 * @sideEffects Creates a temporary directory with the script, the wrapper and pi's own config.
 * @param script - What the faux model answers.
 * @returns The environment and a cleanup function.
 */
export async function fauxPiEnvironment(script: FauxScript): Promise<FauxPiEnvironment> {
  const dir = await mkdtemp(join(tmpdir(), "atrium-e2e-pi-"));
  const launch = await fauxPi(script, dir);
  const bin = join(dir, "bin");
  await mkdir(bin);
  const quoted = launch.args.map((arg) => `'${arg.replaceAll("'", String.raw`'\''`)}'`).join(" ");
  const wrapper = join(bin, "pi");
  await writeFile(
    wrapper,
    `#!/bin/sh\nif [ "$1" = "--version" ]; then exec "$E2E_REAL_PI" --version; fi\nexec "$E2E_REAL_PI" "$@" ${quoted}\n`,
  );
  await chmod(wrapper, 0o755);
  return {
    env: {
      ...launch.env,
      SHELL: "/usr/bin/false",
      PATH: `${bin}${delimiter}${process.env["PATH"] ?? ""}`,
      E2E_REAL_PI: await realPi(),
    },
    agentDir: launch.agentDir,
    release: (name) => launch.release(name),
    pid: () => launch.pid(),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}
