import type { Preferences } from "@atrium/protocol";
import type { IndexFile } from "./index-file";
import type { PreferencesDocument } from "./index-schema";

/** Global preferences. */
export interface PreferenceStore {
  read(): Preferences;
  /** Changes the given preferences and writes them; the rest stay. */
  set(changes: Partial<Preferences>): Promise<void>;
}

/**
 * Creates the preference store over `preferences.json`.
 *
 * @remarks
 * Appearance follows the system and the display mode is the summary until changed (SPEC-0001,
 * "外观", "显示模式").
 *
 * @sideEffects none until `set`; then writes `preferences.json`.
 * @param file - The loaded file.
 * @returns The store.
 */
export function createPreferenceStore(file: IndexFile<PreferencesDocument>): PreferenceStore {
  return {
    read() {
      const { appearance, displayMode } = file.read();
      return { appearance, displayMode };
    },
    set: (changes) => file.save({ ...file.read(), ...changes }),
  };
}
