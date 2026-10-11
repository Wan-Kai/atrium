import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * A stand-in for pi's package entry, driven by the `FAKE_PI` scenario in its environment.
 *
 * @remarks
 * Real pi cannot finish an OAuth login without a browser and the provider's servers, nor fail one on
 * demand, so the login tests of `packages/pi` and of the host run against this module instead: it has
 * the shape of the part of pi the login program uses (`ModelRuntime`, `getAgentDir`,
 * `SettingsManager`). Scenarios that must outlive a deadline keep an interval running, since a
 * pending promise alone lets Node exit.
 */
export const FAKE_PI_SOURCE = `
import { writeSync } from "node:fs";
const scenario = process.env.FAKE_PI;
const keepAlive = () => setInterval(() => undefined, 1000);
const runtime = {
  getProviders: () => [
    { id: "acme", name: "Acme", auth: { oauth: { name: "Acme (Pro)", loginLabel: "Sign in with Acme", isSubscription: true }, apiKey: { name: "Acme key", login: async () => ({}) } } },
    { id: "ambient", name: "Ambient", auth: { apiKey: { name: "Ambient" } } },
    { id: "beta", name: "Beta", auth: { oauth: { name: "Beta OAuth" } } },
    { id: "openai-codex", name: "Codex", auth: { oauth: { name: "ChatGPT (Codex)" } } },
    { id: "radius", name: "Radius", auth: { apiKey: { name: "Radius", login: async () => ({}) } } },
  ],
  listCredentials: async () => [{ providerId: "acme", type: "oauth" }],
  checkAuth: async (id) => (id === "acme" ? { type: "oauth", source: "OAuth" } : id === "ambient" ? { type: "api_key" } : undefined),
  async login(id, type, interaction, options) {
    if (scenario === "complete") {
      interaction.notify({ type: "device_code", userCode: "ABCD-EFGH", verificationUri: "https://acme.test/device", expiresInSeconds: 900 });
      interaction.notify({ type: "device_code", userCode: "WXYZ", verificationUri: "https://acme.test/d" });
      interaction.notify({ type: "progress", message: "Waiting" });
      interaction.notify({ type: "info", message: "Read this", links: [{ url: "https://acme.test/help", label: "Help" }] });
      interaction.notify({ type: "info", message: "No links" });
      interaction.notify({ type: "auth_url", url: "https://acme.test/authorize" });
      const pick = await interaction.prompt({ type: "select", message: "Which?", options: [{ id: "a", label: "A", description: "first" }, { id: "b", label: "B" }] });
      const code = await interaction.prompt({ type: "text", message: "Code?", placeholder: "123" });
      if (pick !== "b" || code !== "42" || options.getDeviceId() !== "device-7") throw new Error("wrong answers");
      return { type: "oauth", refresh: "r", access: "a", expires: 1 };
    }
    if (scenario === "withdrawn") {
      const local = new AbortController();
      const asked = interaction.prompt({ type: "manual_code", message: "Paste", signal: local.signal }).catch(() => "withdrawn");
      setTimeout(() => local.abort(), 50);
      if ((await asked) !== "withdrawn") throw new Error("not withdrawn");
      return { type: "oauth", refresh: "r", access: "a", expires: 1 };
    }
    if (scenario === "browser") {
      const how = await interaction.prompt({ type: "select", message: "How?", options: [{ id: "copy_code", label: "Copy" }, { id: "browser", label: "Browser" }] });
      if (how !== "browser") throw new Error("not the browser");
      return { type: "oauth", refresh: "r", access: "a", expires: 1 };
    }
    if (scenario === "api-key") {
      const account = await interaction.prompt({ type: "text", message: "Account?" });
      const key = await interaction.prompt({ type: "secret", message: "Key?" });
      const again = await interaction.prompt({ type: "secret", message: "Again?" });
      if (type !== "api_key" || account !== "acct" || key !== "sk-1" || again !== "sk-1") throw new Error("wrong answers");
      return { type: "api_key", key };
    }
    if (scenario === "noisy") {
      process.stdout.write("pi says hello\\n");
      writeSync(2, "x".repeat(1 << 20));
      return { type: "oauth", refresh: "r", access: "a", expires: 1 };
    }
    if (scenario === "patient") {
      interaction.notify({ type: "progress", message: "Waiting" });
      await new Promise((resolve) => interaction.signal.addEventListener("abort", resolve));
      throw new Error("aborted");
    }
    if (scenario === "insecure" || scenario === "insecure-device") {
      if (scenario === "insecure") interaction.notify({ type: "auth_url", url: "http://acme.test/authorize" });
      else interaction.notify({ type: "device_code", userCode: "ABCD", verificationUri: "http://acme.test/device" });
      await new Promise((resolve) => interaction.signal.addEventListener("abort", resolve));
      throw new Error("aborted");
    }
    if (scenario === "long") {
      const page = (letter) => letter.repeat(20000);
      interaction.notify({ type: "auth_url", url: "https://acme.test/authorize", instructions: page("i") });
      interaction.notify({ type: "progress", message: page("p") });
      await interaction.prompt({ type: "select", message: page("m"), placeholder: page("h"), options: [{ id: "a", label: page("l") }] });
      throw new Error(page("e"));
    }
    if (scenario === "fail") throw new Error("token exchange failed: 400");
    if (scenario === "fail-value") throw "plain failure";
    if (scenario === "deaf") {
      keepAlive();
      return new Promise(() => undefined);
    }
    if (scenario === "exit") process.exit(3);
    throw new Error("unknown scenario " + scenario);
  },
  async logout(id) {
    if (scenario === "logout-fails") throw new Error("locked " + id);
    if (scenario === "logout-hangs") {
      keepAlive();
      await new Promise(() => undefined);
    }
  },
};
export const getAgentDir = () => "/agent";
export const SettingsManager = { create: (cwd, agentDir) => ({ getOrCreateDeviceId: () => (cwd === "/agent" && agentDir === "/agent" ? "device-7" : "wrong") }) };
export const ModelRuntime = {
  async create(options) {
    if (options.allowModelNetwork !== false) throw new Error("network allowed");
    if (scenario === "create-fails") throw new Error("auth.json is corrupt");
    if (scenario === "status-hangs") {
      keepAlive();
      await new Promise(() => undefined);
    }
    return runtime;
  },
};
`;

/** Where a fake pi package was written. */
export interface FakePiPackage {
  /** The package directory. */
  readonly root: string;
  /** File URL of its `dist/index.js`, as the login program takes it. */
  readonly entry: string;
  /** Its `dist/bundle/cli.js`, where an installed `pi` command links to. */
  readonly cli: string;
}

/**
 * Writes a package named like pi under `node_modules` in a directory.
 *
 * @remarks
 * With pi's name, the host finds its entry the way it finds the real one; an empty module stands
 * for a pi without the exports the login program needs.
 *
 * @sideEffects Writes files under `dir`.
 * @param dir - The directory; a real path, so the entry matches what the host derives.
 * @param source - The entry module's source.
 * @returns Where the package is.
 */
export async function writeFakePiPackage(dir: string, source: string = FAKE_PI_SOURCE): Promise<FakePiPackage> {
  const root = join(dir, "node_modules", "@earendil-works", "pi-coding-agent");
  await mkdir(join(root, "dist", "bundle"), { recursive: true });
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "@earendil-works/pi-coding-agent", type: "module" }),
  );
  await writeFile(join(root, "dist", "index.js"), source);
  const cli = join(root, "dist", "bundle", "cli.js");
  await writeFile(cli, "");
  return { root, entry: pathToFileURL(join(root, "dist", "index.js")).href, cli };
}
