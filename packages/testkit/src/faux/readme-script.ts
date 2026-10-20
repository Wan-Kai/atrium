import { fileURLToPath } from "node:url";
import type { FauxBlock } from "./script";

/** Environment variable that tells the README extension where its script is; not `ATRIUM_*`, which the host keeps from pi. */
export const README_FAUX_SCRIPT_ENV = "README_FAUX_SCRIPT";

/** Environment variable naming the directory whose files release the README extension's gated replies. */
export const README_FAUX_GATES_ENV = "README_FAUX_GATES";

/** Environment variable naming the file the README extension notes each reply it gives in, for debugging a run. */
export const README_FAUX_LOG_ENV = "README_FAUX_LOG";

/** The pi extension that answers as several providers for the README screenshots, as a path for `--extension`. */
export const README_FAUX_EXTENSION = fileURLToPath(new URL("readme-extension.ts", import.meta.url));

/** One scripted reply of the README conversation; a reply with `waitFor` holds until that gate file exists. */
export interface ReadmeFauxReply {
  readonly blocks: readonly FauxBlock[];
  readonly waitFor?: string;
}

/** A model a README provider offers, as its settings and model panel show it. */
interface ReadmeFauxModel {
  readonly id: string;
  readonly name: string;
  /** Whether the model thinks; `true` unless said otherwise. */
  readonly reasoning?: boolean;
  /** What it accepts; text and images unless said otherwise. */
  readonly input?: readonly ("text" | "image")[];
  readonly contextWindow?: number;
  readonly maxTokens?: number;
  /** pi's per-model thinking map: `null` drops a level; `xhigh` and `max` exist only when named. */
  readonly thinkingLevelMap?: Readonly<
    Partial<Record<"off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max", string | null>>
  >;
}

/** A provider the README extension registers under a real provider's name. */
export interface ReadmeFauxProvider {
  readonly id: string;
  /** Where the provider's other requests go, such as Codex's model list; nowhere when absent. */
  readonly baseUrl?: string;
  /** Reply headers handed to pi's `after_provider_response`, such as a plan's usage. */
  readonly headers?: Readonly<Record<string, string>>;
  readonly models: readonly ReadmeFauxModel[];
}

/** The whole README conversation: the providers, the main agent's replies and each child's. */
export interface ReadmeFauxScript {
  readonly providers: readonly ReadmeFauxProvider[];
  readonly replies: readonly ReadmeFauxReply[];
  /** A child answers from the first entry whose `match` appears in its conversation, its task. */
  readonly children: readonly { readonly match: string; readonly replies: readonly ReadmeFauxReply[] }[];
  /** What pi answers in print mode when asked for a title. */
  readonly title?: string;
  /** What pi answers in print mode when told to name a git branch. */
  readonly branch?: string;
  readonly tokensPerSecond?: number;
}
