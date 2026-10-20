import { createTempDir } from "@atrium/testkit";
import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { startTestHost } from "../../test/harness";

it("edits isolated pi config through the real host and client without logging file contents or paths", async () => {
  const temporary = await createTempDir("config-host");
  onTestFinished(temporary.cleanup);
  const root = await realpath(temporary.path);
  const directory = join(root, "isolated-agent-config");
  const host = await startTestHost({ toolEnv: { PATH: "", HOME: root, PI_CODING_AGENT_DIR: directory } });
  onTestFinished(host.dispose);
  const client = host.connect();
  onTestFinished(() => client.disconnect());
  await client.connect();
  const missing = await client.readPiConfig(null, "settings.json");
  expect(missing).toStrictEqual({ path: join(directory, "settings.json"), text: "{}\n", revision: null });
  const text = '{"privateConfigMarker":"never-log-this-config-value"}\n';
  const saved = await client.savePiConfig(null, "settings.json", text, null);
  expect(saved).toMatchObject({ path: missing.path, text });
  expect(await readFile(missing.path, "utf8")).toBe(text);
  expect(await client.readPiConfig(null, "settings.json")).toStrictEqual(saved);
  await expect(client.savePiConfig(null, "settings.json", "{}", null)).rejects.toMatchObject({
    code: "config_conflict",
  });
  await expect(client.savePiConfig(null, "settings.json", "[]", saved.revision)).rejects.toMatchObject({
    code: "config_invalid",
  });
  await expect(
    client.savePiConfig(null, "settings.json", '{"invalid-json-sentinel":never-log-invalid-config', saved.revision),
  ).rejects.toMatchObject({ code: "config_invalid" });
  for (const name of ["auth.json", "mcp-auth.json", "../auth.json"] as const) {
    await expect(client.readPiConfig(null, name as "settings.json")).rejects.toMatchObject({ code: "invalid_message" });
    await expect(client.savePiConfig(null, name as "settings.json", "{}", null)).rejects.toMatchObject({
      code: "invalid_message",
    });
  }
  await expect(client.readPiConfig("wks_ffffffffffffffff", "settings.json")).rejects.toMatchObject({
    code: "workspace_not_found",
  });
  const logs = JSON.stringify(await host.readLog());
  expect(logs).not.toContain(directory);
  expect(logs).not.toContain("never-log-this-config-value");
  expect(logs).not.toContain("never-log-invalid-config");
  expect(logs).not.toContain("invalid-json-sentinel");
});
