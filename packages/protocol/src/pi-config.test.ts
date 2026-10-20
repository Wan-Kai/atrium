import { describe, expect, it } from "vitest";
import { Command, CommandResult, ErrorCode, PI_PROJECT_CONFIG_NAMES, PiConfigFile, PiConfigName } from "./index";

const fields = { requestId: "r1", traceparent: "00-11111111111111111111111111111111-2222222222222222-01" };
const revision = "a".repeat(64);

describe("pi configuration boundary", () => {
  it("shares only settings and MCP names for project configuration", () => {
    expect(PI_PROJECT_CONFIG_NAMES).toStrictEqual(["settings.json", "mcp.json"]);
  });
  it.each(["settings.json", "models.json", "mcp.json", "keybindings.json"])(
    "allows only ordinary config %s",
    (name) => {
      expect(PiConfigName.parse(name)).toBe(name);
      const command = { type: "read_pi_config", ...fields, workspaceId: null, name };
      expect(Command.parse(command)).toStrictEqual(command);
    },
  );

  it.each(["auth.json", "mcp-auth.json", "../auth.json", "/tmp/settings.json", "SYSTEM.md"])("refuses %s", (name) => {
    expect(PiConfigName.safeParse(name).success).toBe(false);
    expect(Command.safeParse({ type: "read_pi_config", ...fields, workspaceId: null, name }).success).toBe(false);
  });

  it("carries the original revision and exact text through reads and saves", () => {
    const command = {
      type: "save_pi_config",
      ...fields,
      workspaceId: "wks_0000000000000001",
      name: "settings.json",
      text: '{\n  "theme": "dark"\n}\n',
      revision,
    };
    const result = { path: "/workspace/.pi/settings.json", text: command.text, revision };
    expect(Command.parse(command)).toStrictEqual(command);
    expect(CommandResult.read_pi_config.parse(result)).toStrictEqual(result);
    expect(CommandResult.save_pi_config.parse(result)).toStrictEqual(result);
    expect(PiConfigFile.parse({ path: result.path, text: "{}\n", revision: null })).toStrictEqual({
      path: result.path,
      text: "{}\n",
      revision: null,
    });
  });

  it("rejects missing or malformed versions and oversized payloads", () => {
    const command = { type: "save_pi_config", ...fields, workspaceId: null, name: "mcp.json", text: "{}", revision };
    expect(Command.safeParse({ ...command, revision: "old" }).success).toBe(false);
    expect(Command.safeParse({ ...command, revision: `x${revision}` }).success).toBe(false);
    expect(Command.safeParse({ ...command, revision: `${revision}x` }).success).toBe(false);
    expect(Command.safeParse({ ...command, revision: undefined }).success).toBe(false);
    expect(Command.safeParse({ ...command, text: " ".repeat(256 * 1024 + 1) }).success).toBe(false);
    expect(PiConfigFile.safeParse({ path: "/a", text: " ".repeat(256 * 1024 + 1), revision }).success).toBe(false);
  });

  it.each(["config_invalid", "config_conflict", "config_unavailable", "config_too_large", "config_encoding"])(
    "transports %s without error text",
    (code) => {
      expect(ErrorCode.parse(code)).toBe(code);
    },
  );
});
