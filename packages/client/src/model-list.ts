import type { CatalogModel, ModelRef } from "@atrium/protocol";

/** The models pi can use in one container, as far as the client has asked (SPEC-0001, "模型与输入框"). */
export interface ModelListView {
  /** `idle` before the first ask; `loading` while asking, with the last answer still shown. */
  readonly status: "idle" | "loading" | "ready" | "failed";
  readonly models: readonly CatalogModel[];
  /** The model pi picks by its own settings. */
  readonly defaultModel: ModelRef | null;
  /** Why the last ask failed, for the panel to explain. */
  readonly error: Error | null;
}

/** A container's model list before the client has asked for it. */
export const UNASKED_MODELS: ModelListView = { status: "idle", models: [], defaultModel: null, error: null };
