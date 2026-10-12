import {
  type ModelRef,
  type Preferences,
  type SessionModel,
  StatusGroupId,
  type ThinkingLevel,
} from "@atrium/protocol";
import { proxyProblem } from "../platform/proxy";
import type { IndexFile } from "./index-file";
import type { PreferencesDocument } from "./index-schema";

/** Global preferences. */
export interface PreferenceStore {
  read(): Preferences;
  /** Changes the given preferences and writes them; the rest stay. */
  set(changes: Partial<Preferences>): Promise<void>;
  /** Remembers a model chosen in a session, as the last one and with its thinking level. */
  remember(model: SessionModel): Promise<void>;
  /** Remembers Fast switched on or off in a session, for the sessions without their own (SPEC-0001, "Fast"). */
  rememberFast(enabled: boolean): Promise<void>;
  /** The model new sessions start with: the last one chosen, with its thinking level if remembered. */
  preferred(): { readonly model: ModelRef; readonly thinkingLevel: ThinkingLevel | null } | null;
}

/**
 * Creates the preference store over `preferences.json`.
 *
 * @remarks
 * Appearance follows the system and the display mode is the summary until changed (SPEC-0001,
 * "外观", "显示模式"). The model chosen last in any session, and each model's thinking level, are
 * what new sessions start with (SPEC-0001, "模型与输入框"). The status bar's choices, an optional
 * field added in M1.8 without a new version, read as none; an id no group could have, as a hand
 * may write, is left out of what is read (SPEC-0001, "状态栏（M1.8）"). First launch is still to do,
 * and sessions are named with their own model, until told otherwise; a file from before M1.10, without
 * these fields, reads so too (SPEC-0001, "首次启动", "设置"). No proxy is set until one is; one the
 * host would refuse, as a hand may write, reads as none (SPEC-0001, "设置 · pi"). Fast is off until
 * switched on in some session; a file from before M1.11's Fast reads so (SPEC-0001, "Fast").
 *
 * @sideEffects none until `set`; then writes `preferences.json`.
 * @param file - The loaded file.
 * @returns The store.
 */
export function createPreferenceStore(file: IndexFile<PreferencesDocument>): PreferenceStore {
  return {
    read() {
      const {
        setupDone = false,
        appearance,
        displayMode,
        lastModel,
        thinkingByModel,
        lastFast = false,
        statusBar = {},
        titleModel = null,
        proxy = null,
      } = file.read();
      const groups = Object.entries(statusBar).filter(([id]) => StatusGroupId.safeParse(id).success);
      return {
        setupDone,
        appearance,
        displayMode,
        lastModel,
        thinkingByModel,
        lastFast,
        statusBar: Object.fromEntries(groups),
        titleModel,
        proxy: proxy !== null && proxyProblem(proxy) === null ? proxy : null,
      };
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
    rememberFast: (enabled) => file.save({ ...file.read(), lastFast: enabled }),
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
