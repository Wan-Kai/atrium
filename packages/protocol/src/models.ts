import { z } from "zod";

/**
 * How hard a model thinks, as pi names it (pi-internals.md §4).
 *
 * @remarks
 * Which of them a model supports comes from the catalog (SPEC-0001, "模型与输入框").
 */
export const ThinkingLevel = z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
export type ThinkingLevel = z.infer<typeof ThinkingLevel>;

/** A model, named the way pi names it: the provider and the model's id there (domain-model §5). */
export const ModelRef = z.strictObject({
  providerId: z.string().min(1).max(256),
  modelId: z.string().min(1).max(512),
});
export type ModelRef = z.infer<typeof ModelRef>;

/** A model the catalog lists, with what the model panel shows of it. */
export const CatalogModel = z.strictObject({
  ...ModelRef.shape,
  name: z.string().max(512),
  /** Tokens. */
  contextWindow: z.number().int().nonnegative(),
  /** Tokens. */
  maxOutput: z.number().int().nonnegative(),
  supportsImage: z.boolean(),
  /** The levels it supports, lowest first; only `off` for a model that does not think. */
  thinkingLevels: z.array(ThinkingLevel).min(1),
});
export type CatalogModel = z.infer<typeof CatalogModel>;

/** The model a session's pi uses now, and how hard it thinks. */
export const SessionModel = z.strictObject({ ...ModelRef.shape, thinkingLevel: ThinkingLevel });
export type SessionModel = z.infer<typeof SessionModel>;
