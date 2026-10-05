const { writeFileSync } = require("node:fs");

const realExit = process.exit.bind(process);

/**
 * Exits only after a delay, then records that the exit really happened.
 *
 * @remarks
 * The real host closes in a few milliseconds, so a desktop app that does not wait for it would
 * still look fine. Slowing the final exit down makes the race visible: if quitting tears the host
 * down early, the marker file is never written (coverage-map.md, "退出应用时等宿主写完日志").
 *
 * @sideEffects After 1.5 s, writes the exit code to `ATRIUM_TEST_EXIT_MARKER` and exits.
 * @param {number | undefined} code - The exit code the host asked for.
 */
function slowExit(code) {
  setTimeout(() => {
    writeFileSync(String(process.env.ATRIUM_TEST_EXIT_MARKER), String(code ?? 0));
    realExit(code);
  }, 1_500);
}

process.exit = slowExit;
require(String(process.env.ATRIUM_REAL_HOST_ENTRY));
