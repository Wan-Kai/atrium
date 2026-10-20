export {
  type AtriumClient,
  type AtriumClientOptions,
  type ClientClock,
  ConnectionLostError,
  type ConnectionState,
  type InstallJob,
  type RejectionReason,
  createAtriumClient,
} from "./atrium-client";
export { type ChangesView, type DiffView } from "./changes-view";
export { type IndexView } from "./index-view";
export { type ModelListView } from "./model-list";
export { type MessageTag, type PendingMessage, type SessionView, loadingView } from "./session-view";
export { type SetupView } from "./setup-view";
// Runtime protocol values reach the UI through this facade; protocol imports are type-only there (overview.md).
export {
  CommandError,
  PI_CONFIG_MAX_BYTES,
  PI_PROJECT_CONFIG_NAMES,
  PiConfigName,
  ThinkingLevel,
  isAuthFailure,
  isChatId,
} from "@atrium/protocol";
