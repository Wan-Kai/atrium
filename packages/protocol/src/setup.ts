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

/** How to sign in: in the browser or with a device code, or with an API key. */
export const LoginMethod = z.enum(["oauth", "api_key"]);
export type LoginMethod = z.infer<typeof LoginMethod>;

/** An address the user is sent to, which must be `https` (SPEC-0001, "首次启动 · 接口"). */
const HttpsUrl = z.string().max(8192).startsWith("https://");

/** pi's own words in a login, as pi gives them. */
const PiText = z.string().max(16_384);

/** A question pi asks during a login (SPEC-0001, "第 2 步：登录模型"). */
export const LoginQuestion = z.strictObject({
  promptId: z.number().int().nonnegative(),
  kind: z.enum(["text", "secret", "select", "manual_code"]),
  message: PiText,
  placeholder: PiText.nullable(),
  /** The choices of a `select`; empty otherwise. */
  options: z.array(z.strictObject({ id: z.string().max(1024), label: PiText })).max(256),
});
export type LoginQuestion = z.infer<typeof LoginQuestion>;

/** Why a login failed: pi cannot be used, pi said no, pi took too long, or an address was not `https`. */
export const LoginFailureReason = z.enum(["unavailable", "failed", "timed_out", "insecure_url"]);
export type LoginFailureReason = z.infer<typeof LoginFailureReason>;

/**
 * A login's whole state, sent to every connection each time it changes (SPEC-0001, "首次启动 · 接口").
 *
 * @remarks
 * Only the client that started the login opens `authUrl`. `progress` is pi's latest progress or
 * notice, without a notice's links. `error.detail` is pi's own text.
 */
export const LoginUpdatedEvent = z.strictObject({
  type: z.literal("login_updated"),
  loginId: z.string().min(1).max(64),
  providerId: z.string().min(1).max(MODEL_LIMITS.providerId),
  method: LoginMethod,
  state: z.enum(["running", "ok", "failed", "cancelled"]),
  authUrl: z.strictObject({ url: HttpsUrl, instructions: PiText.nullable() }).nullable(),
  deviceCode: z
    .strictObject({
      userCode: z.string().max(1024),
      verificationUri: HttpsUrl,
      expiresInSeconds: z.number().nonnegative().nullable(),
    })
    .nullable(),
  questions: z.array(LoginQuestion).max(64),
  progress: PiText.nullable(),
  error: z.strictObject({ reason: LoginFailureReason, detail: PiText.nullable() }).nullable(),
});
export type LoginUpdatedEvent = z.infer<typeof LoginUpdatedEvent>;
