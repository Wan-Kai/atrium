import { z } from "zod";

/**
 * How hard a model thinks, as pi names it (pi-internals.md §4).
 *
 * @remarks
 * Which of them a model supports comes from the catalog (SPEC-0001, "模型与输入框").
 */
export const ThinkingLevel = z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
export type ThinkingLevel = z.infer<typeof ThinkingLevel>;

/** The longest provider id, model id and model name the protocol carries. */
export const MODEL_LIMITS = { providerId: 256, modelId: 512, name: 512 } as const;

/** A model, named the way pi names it: the provider and the model's id there (domain-model §5). */
export const ModelRef = z.strictObject({
  providerId: z.string().min(1).max(MODEL_LIMITS.providerId),
  modelId: z.string().min(1).max(MODEL_LIMITS.modelId),
});
export type ModelRef = z.infer<typeof ModelRef>;

/** A model the catalog lists, with what the model panel shows of it. */
export const CatalogModel = z.strictObject({
  ...ModelRef.shape,
  name: z.string().max(MODEL_LIMITS.name),
  /** Tokens. */
  contextWindow: z.number().int().nonnegative(),
  /** Tokens. */
  maxOutput: z.number().int().nonnegative(),
  supportsImage: z.boolean(),
  /** The levels it supports, lowest first; only `off` for a model that does not think. */
  thinkingLevels: z.array(ThinkingLevel).min(1),
  /** What Fast does for the model, as Codex's model list says; `null` when it has no Fast (SPEC-0001, "Fast"). */
  fast: z
    .object({
      /** About how many times as fast, or `null` when not said. */
      speed: z.number().positive().max(100).nullable(),
      /** Whether it uses more of the subscription's credits. */
      moreUsage: z.boolean(),
    })
    .strict()
    .nullable(),
});
export type CatalogModel = z.infer<typeof CatalogModel>;

/** The model a session's pi uses now, and how hard it thinks. */
export const SessionModel = z.strictObject({ ...ModelRef.shape, thinkingLevel: ThinkingLevel });
export type SessionModel = z.infer<typeof SessionModel>;
