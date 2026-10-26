// The host side of the spike: asks for the vault, bumps a counter, writes it back, exits.
let next = 0;
const waiting = new Map();
process.parentPort.on("message", ({ data }) => {
  const done = waiting.get(data.id);
  waiting.delete(data.id);
  done?.(data);
});

/**
 * Sends one request to the main process and waits for its answer.
 *
 * @sideEffects Posts a message to the main process.
 * @param {object} message - The request.
 * @returns {Promise<object>} The answer.
 */
function ask(message) {
  const id = ++next;
  return new Promise((resolve) => {
    waiting.set(id, resolve);
    process.parentPort.postMessage({ ...message, id });
  });
}

(async () => {
  const read = await ask({ type: "vault_read" });
  const vault = read.data === null ? { runs: 0, hostKey: "spike-private-key" } : JSON.parse(read.data);
  vault.runs += 1;
  const written = await ask({ type: "vault_write", data: JSON.stringify(vault) });
  process.exit(written.ok ? 0 : 1);
})();
