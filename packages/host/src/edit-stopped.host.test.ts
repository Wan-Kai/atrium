import type { AtriumClient, SessionView } from "@atrium/client";
import { CommandError, type Turn } from "@atrium/protocol";
import { createTempDir, fauxPi, present } from "@atrium/testkit";
import { access, chmod, mkdir, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { startTestHost } from "../test/harness";

const ATRIUM_EXTENSION = fileURLToPath(new URL("../../pi/src/extension/atrium.ts", import.meta.url));
const IMAGE = {
  mimeType: "image/png",
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
} as const;

/**
 * Finds the installed pi without loading the user's configuration.
 * @remarks Only its executable is reused; fauxPi supplies an isolated agent directory.
 * @sideEffects Checks executable paths on disk.
 * @returns The pi executable.
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
  throw new Error("pi is not on PATH; stopped-message integration needs it installed");
}

/**
 * Starts a real host and client with a gated faux model in an isolated home.
 * @remarks The first reply can be stopped deterministically; the replacement is gated separately.
 * @sideEffects Creates temporary files, starts pi and the host, and opens a WebSocket connection.
 * @param withExtension - Whether pi loads Atrium's edit command; false exercises missing-extension rejection.
 * @returns The connected client, session view, and faux controls.
 */
async function editingChat(withExtension = true) {
  const dir = await createTempDir("edit-stopped-host");
  onTestFinished(dir.cleanup);
  const launch = await fauxPi(
    {
      title: "Editing stopped messages",
      replies: [
        { waitFor: "wrong", blocks: [{ type: "text", text: "discarded answer" }] },
        { waitFor: "correct", blocks: [{ type: "text", text: "replacement answer" }] },
        { blocks: [{ type: "text", text: "queued answer" }] },
      ],
    },
    dir.path,
  );
  await writeFile(join(launch.agentDir, "settings.json"), JSON.stringify({ images: { autoResize: false } }));
  const bin = join(dir.path, "bin");
  await mkdir(bin);
  const quoted = launch.args.map((arg) => `'${arg.replaceAll("'", String.raw`'\''`)}'`).join(" ");
  const wrapper = join(bin, "pi");
  await writeFile(
    wrapper,
    `#!/bin/sh\nif [ "$1" = "--version" ]; then exec "$EDIT_REAL_PI" --version; fi\nexec "$EDIT_REAL_PI" "$@" ${quoted}\n`,
  );
  await chmod(wrapper, 0o755);
  const host = await startTestHost({
    ...(withExtension ? { fastExtension: ATRIUM_EXTENSION } : {}),
    toolEnv: {
      ...launch.env,
      HOME: dir.path,
      PATH: `${bin}${delimiter}${process.env["PATH"] ?? ""}`,
      EDIT_REAL_PI: await realPi(),
    },
  });
  onTestFinished(host.dispose);
  await host.host.tools;
  const client = host.connect();
  onTestFinished(() => client.disconnect());
  expect(await client.connect()).toMatchObject({ status: "connected" });
  const { sessionId } = await client.createChat();
  await client.watch([sessionId]);
  const view = present(client.session(sessionId), "the session view");
  await vi.waitFor(() => expect(view.getState().status).toBe("ready"));
  await client.prompt(sessionId, "wrong");
  await vi.waitFor(async () => expect(await launch.contexts()).toHaveLength(1), { timeout: 10_000 });
  await vi.waitFor(() => expect(turns(view.getState()).map((turn) => turn.user.text)).toStrictEqual(["wrong"]));
  return { client, sessionId, view, launch };
}

/**
 * Selects the complete turns visible to the client.
 * @remarks Notices are not editable turns and may be interleaved with them.
 * @sideEffects none
 * @param view - The subscribed session's current state.
 * @returns Its turns in transcript order.
 */
function turns(view: SessionView): Turn[] {
  return view.items.filter((item): item is Turn => item.kind === "turn");
}

/**
 * Stops the gated first reply and waits for the host's editable transcript.
 * @remarks Stop's response alone need not imply the client has received the settled snapshot yet.
 * @sideEffects Sends stop and waits for session events.
 * @param client - The connected client.
 * @param sessionId - The session being stopped.
 * @param view - Its current subscribed view.
 * @returns The stopped turn and the epoch guarding it.
 */
async function stopped(client: AtriumClient, sessionId: string, view: { getState(): SessionView }) {
  expect(await client.stop(sessionId)).toStrictEqual({ confirmed: true });
  await vi.waitFor(() => expect(view.getState().run).toBeNull());
  await vi.waitFor(() => expect(turns(view.getState()).at(-1)?.outcome).toBe("stopped"));
  return { epoch: view.getState().epoch, turn: present(turns(view.getState()).at(-1), "the stopped turn") };
}

describe("editing a stopped message through the real host", () => {
  it("rejects edits after handoff without starting another model request", async () => {
    const { client, sessionId, view, launch } = await editingChat();
    const original = await stopped(client, sessionId, view);
    const contexts = await launch.contexts();
    await client.handOff(sessionId);

    await expect(
      client.editStoppedMessage(sessionId, original.epoch, original.turn.id, "correct"),
    ).rejects.toStrictEqual(new CommandError("session_handed_off", { sessionId }));

    expect(contexts).toHaveLength(1);
    expect(await launch.contexts()).toStrictEqual(contexts);
  }, 30_000);

  it("rejects edits after archiving without starting another model request", async () => {
    const { client, sessionId, view, launch } = await editingChat();
    const original = await stopped(client, sessionId, view);
    const contexts = await launch.contexts();
    await client.archiveSession(sessionId);

    await expect(
      client.editStoppedMessage(sessionId, original.epoch, original.turn.id, "correct"),
    ).rejects.toStrictEqual(new CommandError("session_not_found", { sessionId }));

    expect(contexts).toHaveLength(1);
    expect(await launch.contexts()).toStrictEqual(contexts);
  }, 30_000);

  it("rejects a missing Atrium extension without sending its unknown edit command to the model", async () => {
    const { client, sessionId, view, launch } = await editingChat(false);
    const original = await stopped(client, sessionId, view);
    const contexts = await launch.contexts();
    // A leaked unknown command must finish rather than hide behind the replacement's gate.
    await launch.release("correct");

    await expect(
      client.editStoppedMessage(sessionId, original.epoch, original.turn.id, "correct"),
    ).rejects.toStrictEqual(new CommandError("edit_failed", { epoch: original.epoch + 1, turnId: original.turn.id }));

    expect(await launch.contexts()).toStrictEqual(contexts);
    expect(contexts).toHaveLength(1);
    expect(turns(view.getState())).toStrictEqual([original.turn]);
    expect(view.getState().run).toBeNull();
    expect(view.getState().control).toMatchObject({ paused: "stopped", queue: [] });
  }, 30_000);

  it("replaces the stopped branch in the same session, passes uploaded images, and keeps the queue paused", async () => {
    const { client, sessionId, view, launch } = await editingChat();
    const queued = await client.prompt(sessionId, "queued later");
    expect(queued).toMatchObject({ disposition: "queued" });
    const original = await stopped(client, sessionId, view);
    const { attachmentId } = await client.uploadAttachment(IMAGE.mimeType, IMAGE.data);

    expect(
      await client.editStoppedMessage(sessionId, original.epoch, original.turn.id, "correct", [attachmentId]),
    ).toStrictEqual({ disposition: "started" });
    await vi.waitFor(() => expect(turns(view.getState()).map((turn) => turn.user.text)).toStrictEqual(["correct"]));
    await vi.waitFor(async () => expect(await launch.contexts()).toHaveLength(2), { timeout: 10_000 });
    expect(client.session(sessionId)).toBe(view);
    expect(view.getState().epoch).toBeGreaterThan(original.epoch);
    expect(view.getState().pending).toStrictEqual([]);
    expect(turns(view.getState()).at(-1)).toMatchObject({ user: { text: "correct", images: 1 }, outcome: "running" });
    expect(view.getState().control).toMatchObject({ paused: "stopped", queue: [{ text: "queued later" }] });
    const request = present((await launch.contexts()).at(-1), "the corrected model context");
    expect(request.messages.filter((message) => Reflect.get(Object(message), "role") !== "system")).toStrictEqual([
      expect.objectContaining({
        role: "user",
        content: [
          { type: "text", text: "correct" },
          { type: "image", ...IMAGE },
        ],
      }),
    ]);

    await launch.release("correct");
    await vi.waitFor(() => expect(turns(view.getState()).at(-1)?.outcome).toBe("done"), { timeout: 10_000 });
    await vi.waitFor(() => expect(view.getState().run).toBeNull());
    expect(turns(view.getState()).map((turn) => turn.user.text)).toStrictEqual(["correct"]);
    expect(view.getState().control).toMatchObject({ paused: "stopped", queue: [{ text: "queued later" }] });
    expect(await launch.contexts()).toHaveLength(2);
    expect(client.index.getState().sessions.map((session) => session.sessionId)).toStrictEqual([sessionId]);
  }, 30_000);

  it("rejects busy, stale, reserved, repeated and non-stopped edits without another model request", async () => {
    const { client, sessionId, view, launch } = await editingChat();
    const running = present(turns(view.getState()).at(-1), "the running turn");
    await expect(
      client.editStoppedMessage(sessionId, view.getState().epoch, running.id, "too early"),
    ).rejects.toStrictEqual(new CommandError("session_busy"));
    const original = await stopped(client, sessionId, view);
    await expect(
      client.editStoppedMessage(sessionId, original.epoch + 1, original.turn.id, "stale"),
    ).rejects.toStrictEqual(new CommandError("transcript_changed"));
    await expect(
      client.editStoppedMessage(sessionId, original.epoch, "not-the-last-turn", "stale"),
    ).rejects.toStrictEqual(new CommandError("transcript_changed"));
    await expect(
      client.editStoppedMessage(sessionId, original.epoch, original.turn.id, "/atrium-edit reserved"),
    ).rejects.toStrictEqual(new CommandError("command_reserved"));
    await expect(
      client.editStoppedMessage(sessionId, original.epoch, original.turn.id, "/faux-noop"),
    ).rejects.toStrictEqual(new CommandError("turn_not_editable"));
    expect(turns(view.getState())).toStrictEqual([original.turn]);
    expect(await launch.contexts()).toHaveLength(1);

    await client.editStoppedMessage(sessionId, original.epoch, original.turn.id, "correct");
    await vi.waitFor(async () => expect(await launch.contexts()).toHaveLength(2), { timeout: 10_000 });
    await launch.release("correct");
    await vi.waitFor(() => expect(turns(view.getState()).at(-1)?.outcome).toBe("done"), { timeout: 10_000 });
    await vi.waitFor(() => expect(view.getState().run).toBeNull());
    await expect(
      client.editStoppedMessage(sessionId, original.epoch, original.turn.id, "duplicate"),
    ).rejects.toStrictEqual(new CommandError("transcript_changed"));
    const last = present(turns(view.getState()).at(-1), "the completed replacement");
    await expect(
      client.editStoppedMessage(sessionId, view.getState().epoch, last.id, "not stopped"),
    ).rejects.toStrictEqual(new CommandError("turn_not_editable"));
    expect(turns(view.getState()).map((turn) => turn.user.text)).toStrictEqual(["correct"]);
    expect(await launch.contexts()).toHaveLength(2);
  }, 30_000);
});
