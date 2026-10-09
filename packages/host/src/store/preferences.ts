import type { ModelRef, Preferences, SessionModel, ThinkingLevel } from "@atrium/protocol";
import type { IndexFile } from "./index-file";
import type { PreferencesDocument } from "./index-schema";

/** Global preferences. */
export interface PreferenceStore {
  read(): Preferences;
  /** Changes the given preferences and writes them; the rest stay. */
  set(changes: Partial<Preferences>): Promise<void>;
  /** Remembers a model chosen in a session, as the last one and with its thinking level. */
  remember(model: SessionModel): Promise<void>;
  /** The model new sessions start with: the last one chosen, with its thinking level if remembered. */
  preferred(): { readonly model: ModelRef; readonly thinkingLevel: ThinkingLevel | null } | null;
}

/**
 * Creates the preference store over `preferences.json`.
 *
 * @remarks
 * Appearance follows the system and the display mode is the summary until changed (SPEC-0001,
 * "外观", "显示模式"). The model chosen last in any session, and each model's thinking level, are
 * what new sessions start with (SPEC-0001, "模型与输入框").
 *
 * @sideEffects none until `set`; then writes `preferences.json`.
 * @param file - The loaded file.
 * @returns The store.
 */
export function createPreferenceStore(file: IndexFile<PreferencesDocument>): PreferenceStore {
  return {
    read() {
      const { appearance, displayMode, lastModel, thinkingByModel } = file.read();
      return { appearance, displayMode, lastModel, thinkingByModel };
    },
    set: (changes) => file.save({ ...file.read(), ...changes }),
    remember({ providerId, modelId, thinkingLevel }) {
      const document = file.read();
      return file.save({
        ...document,
        lastModel: { providerId, modelId },
        thinkingByModel: { ...document.thinkingByModel, [`${providerId}/${modelId}`]: thinkingLevel },
      });
    },
    preferred() {
      const { lastModel, thinkingByModel } = file.read();
      if (lastModel === null) return null;
      return {
        model: lastModel,
        thinkingLevel: thinkingByModel[`${lastModel.providerId}/${lastModel.modelId}`] ?? null,
      };
    },
  };
}
