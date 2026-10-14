import { onTestFinished, vi } from "vitest";

/**
 * Catches the browser's downloads instead of saving them.
 *
 * @remarks
 * A test that downloads would otherwise leave files on the machine, or wait on a save dialog.
 *
 * @sideEffects Spies on object URLs and link clicks until the test finishes.
 * @returns Each download's file name, and its content and type once read.
 */
export function caughtDownloads() {
  const blobs: Blob[] = [];
  const names: string[] = [];
  const spies = [
    vi.spyOn(URL, "createObjectURL").mockImplementation((object) => {
      if (!(object instanceof Blob)) throw new Error("only blobs are downloaded");
      blobs.push(object);
      return `blob:test/${blobs.length}`;
    }),
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined),
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      names.push(this.download);
    }),
  ];
  onTestFinished(() => {
    for (const spy of spies) spy.mockRestore();
  });
  return {
    names,
    /** What was downloaded, in order, as `[type, text]`. */
    contents: () => Promise.all(blobs.map(async (blob) => [blob.type, await blob.text()])),
  };
}
