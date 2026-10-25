// MP0 spike: does safeStorage keep the remote vault across runs and re-signing, and how does the
// vault hand-off to a utilityProcess host behave? Writes a report and quits.
const { app, safeStorage, utilityProcess } = require("electron");
const { join } = require("node:path");
const fs = require("node:fs");

const home = process.env.ATRIUM_SPIKE_HOME ?? join(app.getPath("home"), ".atrium-spike");
const vaultPath = join(home, "vault.bin");
const reportPath = join(home, "report.jsonl");

/**
 * Appends one line to the report.
 *
 * @sideEffects Writes to the report file.
 * @param {object} entry - What happened.
 */
function report(entry) {
  fs.mkdirSync(home, { recursive: true });
  fs.appendFileSync(reportPath, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");
}

/**
 * Reads and decrypts the vault, or returns null when there is none.
 *
 * @sideEffects Reads the vault file; may make the keychain prompt.
 * @returns {string | null} The vault text.
 */
function readVault() {
  if (!fs.existsSync(vaultPath)) return null;
  return safeStorage.decryptString(fs.readFileSync(vaultPath));
}

/**
 * Encrypts and writes the vault through a temporary file and a rename.
 *
 * @sideEffects Writes the vault file.
 * @param {string} text - The vault text.
 */
function writeVault(text) {
  const temp = vaultPath + ".tmp";
  fs.writeFileSync(temp, safeStorage.encryptString(text), { mode: 0o600 });
  fs.renameSync(temp, vaultPath);
}

app.whenReady().then(() => {
  const started = Date.now();
  const available = safeStorage.isEncryptionAvailable();
  let before = null;
  let readError = null;
  try {
    before = readVault();
  } catch (error) {
    readError = String(error);
  }
  report({ step: "main", available, readMs: Date.now() - started, before, readError, exe: process.execPath });

  const host = utilityProcess.fork(join(__dirname, "host.cjs"));
  host.on("message", (message) => {
    if (message.type === "vault_read")
      host.postMessage({ type: "vault_result", id: message.id, ok: true, data: before });
    if (message.type === "vault_write") {
      try {
        writeVault(message.data);
        host.postMessage({ type: "vault_result", id: message.id, ok: true });
        report({ step: "write", ok: true, data: message.data });
      } catch (error) {
        host.postMessage({ type: "vault_result", id: message.id, ok: false, error: String(error) });
        report({ step: "write", ok: false, error: String(error) });
      }
    }
  });
  host.on("exit", (code) => {
    report({ step: "host-exit", code, totalMs: Date.now() - started });
    app.quit();
  });
});
