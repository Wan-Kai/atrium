import { z } from "zod";
import { MODEL_LIMITS } from "./models";

/** A `major.minor.patch` version, as the host reports it. */
const VersionText = z.string().regex(/^\d+\.\d+\.\d+$/);

/** A released version of pi, which may be a pre-release. */
const ReleaseText = z
  .string()
  .max(128)
  .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);

/**
 * The latest pi the host found, and when (SPEC-0001, "设置 · 接口").
 *
 * @remarks
 * Both are `null` until a check has found it; a later check that finds nothing keeps the last.
 */
export const PiLatest = z.strictObject({
  latest: ReleaseText.nullable(),
  checkedAt: z.number().int().nonnegative().nullable(),
});
export type PiLatest = z.infer<typeof PiLatest>;

/**
 * pi as first launch sees it (SPEC-0001, "首次启动 · 接口").
 *
 * @remarks
 * `broken` is a pi that is there but does not run; `detail` is then pi's own error output, shown
 * as it is under "展开看原始报错". `latest` and `checkedAt` are the latest pi found, for the
 * settings.
 */
export const SetupPi = z.strictObject({
  state: z.enum(["missing", "broken", "outdated", "ready"]),
  path: z.string().max(4096).nullable(),
  version: VersionText.nullable(),
  minimum: VersionText,
  detail: z.string().max(16_384).nullable(),
  ...PiLatest.shape,
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

/** The latest pi found, sent to every connection each time a check finds it. */
export const PiLatestEvent = z.strictObject({
  type: z.literal("pi_latest"),
  ...PiLatest.shape,
});
export type PiLatestEvent = z.infer<typeof PiLatestEvent>;

/** What an install job does: run pi's install script, `brew install node` or `pi update`. */
export const InstallKind = z.enum(["install_pi", "install_node", "update_pi"]);
export type InstallKind = z.infer<typeof InstallKind>;

/**
 * The whole state of the install job, sent to every connection each time it changes.
 *
 * @remarks
 * `running` is the number of sessions still running while an update waits, `null` otherwise. A
 * failed job has a `reason`: `exit` with the exit code (`null` when a signal ended it),
 * `download_failed` when the install script could not be fetched, `spawn_failed` when the
 * command could not start (SPEC-0001, "首次启动 · 接口").
 */
export const InstallUpdatedEvent = z.strictObject({
  type: z.literal("install_updated"),
  jobId: z.string().min(1).max(64),
  kind: InstallKind,
  state: z.enum(["waiting", "running", "ok", "failed", "cancelled"]),
  running: z.number().int().nonnegative().nullable(),
  exitCode: z.number().int().nullable(),
  reason: z.enum(["exit", "download_failed", "spawn_failed"]).nullable(),
});
export type InstallUpdatedEvent = z.infer<typeof InstallUpdatedEvent>;

/** A piece of an install job's output, stdout and stderr together, as the command wrote it. */
export const InstallOutputEvent = z.strictObject({
  type: z.literal("install_output"),
  jobId: z.string().min(1).max(64),
  text: z.string().min(1).max(1_048_576),
});
export type InstallOutputEvent = z.infer<typeof InstallOutputEvent>;
