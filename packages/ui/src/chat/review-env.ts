import type { Fact, PendingReview, ReviewAction, ReviewProblem } from "@atrium/protocol";
import { createContext } from "react";

/**
 * The words and links a review card needs from where it sits.
 *
 * @remarks
 * The host sends codes and parameters, and the words are the UI's (coding-standards, ADR-0018 decision 4). The card
 * itself is generic; the source of the review (the task, later an agent's request) provides its own words through
 * this, so the card reads a `PendingReview` and nothing about tasks.
 */
export interface ReviewEnv {
  /** The top line's "what is reviewed", from the subject's code and parameters. */
  readonly subject: (review: PendingReview) => string;
  /** The one-word source before it: "任务", "agent 请你审核". */
  readonly source: (review: PendingReview) => string;
  /** One fact's sentence. */
  readonly fact: (fact: Fact) => string;
  /** The problem band's sentence, and whether it is the red kind. */
  readonly problem: (problem: ReviewProblem) => { readonly text: string; readonly danger: boolean };
  /** A button's label; a target is named when the button needs one. */
  readonly action: (action: ReviewAction, review: PendingReview) => string;
  /** The small icon a button carries, if it has one. */
  readonly icon: (action: ReviewAction, review: PendingReview) => ActionIconName | null;
  /** A line of small print at the right of the buttons ("还能打回 2 次"), if the review has one. */
  readonly note: (review: PendingReview) => string | null;
  /** The button that sends the verdict once its reason or target is filled in. */
  readonly confirm: (action: ReviewAction, review: PendingReview) => string;
  /** A node's name, for the diff and the targets. */
  readonly nodeName: (node: string) => string | undefined;
  /** Opens the changes of a workspace in the changes panel. */
  readonly openChanges: (workspaceId: string) => void;
  /** Shows a proposed graph on the graph, as the card's "在图上看" link. */
  readonly showOnGraph: (version: number) => void;
}

/** The icons a review's buttons can carry. */
export type ActionIconName = "merge" | "back" | "retry";

/** The words for a review whose source brought none: the codes themselves. */
const PLAIN_REVIEW_ENV: ReviewEnv = {
  subject: (review) => ("text" in review.subject ? review.subject.text : review.subject.code),
  source: (review) => (review.source.kind === "agent" ? "agent 请你审核" : "审核"),
  fact: (fact) => fact.code,
  problem: (problem) => ({ text: problem.code, danger: false }),
  action: (action) => action.id,
  confirm: (action) => action.id,
  icon: () => null,
  note: () => null,
  nodeName: () => undefined,
  openChanges: () => undefined,
  showOnGraph: () => undefined,
};

/** What the review cards below read their words and links from. */
export const ReviewEnvContext = createContext<ReviewEnv>(PLAIN_REVIEW_ENV);
