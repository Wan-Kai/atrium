import { z } from "zod";
import { MODEL_LIMITS } from "./models";

/** A `major.minor.patch` version, as the host reports it. */
const VersionText = z.string().regex(/^\d+\.\d+\.\d+$/);

/**
 * pi as first launch sees it (SPEC-0001, "首次启动 · 接口").
 *
 * @remarks
 * `broken` is a pi that is there but does not run; `detail` is then pi's own error output, shown
 * as it is under "展开看原始报错".
 */
export const SetupPi = z.strictObject({
  state: z.enum(["missing", "broken", "outdated", "ready"]),
  path: z.string().max(4096).nullable(),
  version: VersionText.nullable(),
  minimum: VersionText,
  detail: z.string().max(16_384).nullable(),
});
export type SetupPi = z.infer<typeof SetupPi>;

/** The Node pi runs on; it must be 22.19 or newer. */
export const SetupNode = z.strictObject({
  state: z.enum(["missing", "outdated", "ready"]),
  version: VersionText.nullable(),
});
export type SetupNode = z.infer<typeof SetupNode>;

/**
 * A provider first launch and the settings list, and how it is signed in.
 *
 * @remarks
 * `name` and the OAuth `label` are pi's own words. `signedIn.stored` is false for a key that comes
 * from the environment, which logging out does not remove.
 */
export const SetupProvider = z.strictObject({
  providerId: z.string().min(1).max(MODEL_LIMITS.providerId),
  name: z.string().max(MODEL_LIMITS.name),
  oauth: z.strictObject({ label: z.string().max(MODEL_LIMITS.name), subscription: z.boolean() }).nullable(),
  apiKey: z.boolean(),
  signedIn: z.strictObject({ method: z.enum(["oauth", "api_key"]), stored: z.boolean() }).nullable(),
});
export type SetupProvider = z.infer<typeof SetupProvider>;

/** Whether Atrium can sign in through pi, and the providers when it can. */
export const SetupLogin = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("unavailable") }),
  z.strictObject({ state: z.literal("ready"), providers: z.array(SetupProvider) }),
]);
export type SetupLogin = z.infer<typeof SetupLogin>;

/** What first launch checks (SPEC-0001, "首次启动 · 接口"). */
export const SetupState = z.strictObject({
  pi: SetupPi,
  node: SetupNode,
  homebrew: z.boolean(),
  fd: z.boolean(),
  login: SetupLogin,
  /** Projects added so far. */
  projects: z.number().int().nonnegative(),
});
export type SetupState = z.infer<typeof SetupState>;
