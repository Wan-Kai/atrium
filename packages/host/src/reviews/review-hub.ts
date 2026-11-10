import { CommandError, type PendingReview, REVIEWS_LIMIT, type Verdict } from "@atrium/protocol";
import type { Logger } from "../platform/logger";
import type { ResourceTracker } from "../platform/resources";

/**
 * Where a kind of review comes from (ADR-0018, decision 2).
 *
 * @remarks
 * The hub knows nothing of tasks or agents. A provider says what waits in a session, carries out a verdict (the
 * rest of what a review means is its own: a gate runs the business command, an agent request answers the tool
 * call), and tells the hub when what waits may have changed.
 */
export interface ReviewProvider {
  /**
   * What waits for a verdict in the session now, worked out from the provider's own state.
   *
   * @remarks
   * Not stored anywhere else: a gate's reviews are worked out again from the durable state they come from, so
   * they are the same after a host restart. An empty list for a session the provider has nothing to do with.
   */
  pending(sessionId: string, signal: AbortSignal): Promise<readonly PendingReview[]>;
  /**
   * Carries out a verdict the hub has found to fit the review, or fails with a `CommandError`.
   *
   * @remarks
   * Runs alone for its session: no other verdict or recount of the session runs at the same time.
   */
  decide(sessionId: string, review: PendingReview, verdict: Verdict, signal: AbortSignal): Promise<void>;
  /** Calls `changed` with a session whenever its reviews may be different; returns a function that stops it. */
  subscribe(changed: (sessionId: string) => void): () => void;
}

/** The hub the session layer and the router use. */
export interface ReviewHub {
  /** Adds a provider; returns a function that takes it away again. */
  register(provider: ReviewProvider): () => void;
  /**
   * The reviews last worked out for a session, for its run control.
   *
   * @remarks
   * Synchronous, because the control is. A session not looked at before is looked at now and the answer
   * follows through `onChanged`.
   */
  current(sessionId: string): readonly PendingReview[];
  /**
   * Says a controller now reads a session's reviews, so a count is kept for it even when nothing waits.
   *
   * @remarks
   * Until `forget`. Said by the session layer when it holds a controller, not by `current`: a control built late, by a
   * controller that was let go of, must not make the hub keep the session (T8 review fix 13).
   */
  read(sessionId: string): void;
  /**
   * Lets go of what is kept for a session that is no longer read (its controller is gone).
   *
   * @remarks
   * T8 review fix 13: without it the hub would keep a count for every session it was ever asked about. A session
   * that still has reviews is kept until they are gone; one read again is looked at again.
   */
  forget(sessionId: string): void;
  /**
   * Counts a session's reviews again now, as if a provider had said they may have changed.
   *
   * @remarks
   * For what no event tells: the facts on a card come from the worktree, which can be edited while a node waits
   * (T8 review fix 11). The listeners hear of it when the count differs.
   */
  refresh(sessionId: string): void;
  /** Calls `listener` with a session whenever its reviews changed; returns a function that stops it. */
  onChanged(listener: (sessionId: string) => void): () => void;
  /**
   * Gives a verdict on a review of a session.
   *
   * @remarks
   * The first verdict on a review wins: a review that is gone (answered, or its state moved on) fails with
   * `review_closed`. A verdict that does not fit it fails with `review_invalid`.
   */
  answer(sessionId: string, reviewId: string, verdict: Verdict): Promise<void>;
  /** Resolves once every recount and verdict under way is done. */
  idle(): Promise<void>;
  /** Stops the recounts under way and drops the providers and listeners. */
  close(): Promise<void>;
}

/** One session's work, one piece after the other. */
interface Lane {
  /** The last piece of work; the next one starts when it is done. */
  tail: Promise<unknown>;
  /** A recount is waiting in line, so another need not be added. */
  recountQueued: boolean;
}

/**
 * Checks a verdict against the review it answers.
 *
 * @remarks
 * The shape only (ADR-0018, decision 2): the action exists, the reason is there when the action requires one and
 * is not there when it takes none, and the target is one of the action's targets (and given only then). Whether the
 * state still allows it is the provider's business command's to say.
 *
 * @sideEffects none
 * @param review - The review.
 * @param verdict - The verdict.
 * @throws {CommandError} `review_invalid` with `params.field`.
 */
function checkVerdict(review: PendingReview, verdict: Verdict): void {
  const action = review.actions.find((candidate) => candidate.id === verdict.action);
  if (action === undefined) throw new CommandError("review_invalid", { field: "action" });
  const named = action.targets.length > 0;
  if (named ? !action.targets.some((target) => target.id === verdict.target) : verdict.target !== undefined) {
    throw new CommandError("review_invalid", { field: "target" });
  }
  const written = (verdict.reason ?? "").trim() !== "";
  if (action.reason === "required" ? !written : action.reason === "none" && verdict.reason !== undefined) {
    throw new CommandError("review_invalid", { field: "reason" });
  }
}

/**
 * Creates the review hub.
 *
 * @remarks
 * ADR-0018, decision 2. It gathers each session's pending reviews from the providers, keeps the last count for the
 * run control and tells its listeners when a session's changed, checks a verdict's shape, lets only the first
 * verdict on a review through, and hands it to the provider that raised it. Everything for one session happens one
 * piece at a time, so two verdicts cannot both pass the check. It writes no words for people.
 *
 * @sideEffects none until a provider is registered; then asks it and calls its listeners.
 * @param options - The logger and the resource counts.
 * @returns The hub.
 */
export function createReviewHub(options: { readonly logger: Logger; readonly resources: ResourceTracker }): ReviewHub {
  const providers = new Set<{ readonly provider: ReviewProvider; readonly stop: () => void }>();
  const listeners = new Map<(sessionId: string) => void, () => void>();
  const known = new Map<string, readonly PendingReview[]>();
  const lanes = new Map<string, Lane>();
  /** The sessions a controller reads through `current`; they keep a count even when nothing waits in them. */
  const reading = new Set<string>();
  /** The resource count held for each session the hub keeps anything about (`review.session`). */
  const holding = new Map<string, () => void>();
  const closing = new AbortController();
  // The kind is known from the start, at zero, so a snapshot taken before any session was looked at has it too.
  options.resources.acquire("review.session")();

  /**
   * Holds or gives back the resource count of a session, by whether the hub still keeps anything about it.
   *
   * @remarks
   * The count is what the leak tests read: a long-lived hub must come back to zero once its sessions are done.
   *
   * @sideEffects Acquires or releases a resource count.
   * @param sessionId - The session.
   */
  function account(sessionId: string): void {
    const kept = known.has(sessionId) || reading.has(sessionId) || lanes.has(sessionId);
    const release = holding.get(sessionId);
    if (kept && release === undefined) {
      holding.set(sessionId, options.resources.acquire("review.session"));
    } else if (!kept && release !== undefined) {
      holding.delete(sessionId);
      release();
    }
  }

  /**
   * Puts work at the end of a session's line.
   *
   * @remarks
   * A failure of earlier work does not stop the work after it.
   *
   * @sideEffects Runs `work` later.
   * @param sessionId - The session.
   * @param work - What to do.
   * @returns What `work` returns.
   */
  function inLane<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
    const lane = lanes.get(sessionId) ?? { tail: Promise.resolve(), recountQueued: false };
    lanes.set(sessionId, lane);
    account(sessionId);
    const turn = lane.tail.then(work, work);
    /**
     * Ends this piece of work's place in the line.
     *
     * @remarks
     * A line with nothing more in it is dropped; the next piece of work makes a new one. A failure of the work is the
     * caller's, so it is not passed on here.
     *
     * @sideEffects May drop the lane and give back its resource count.
     */
    const dropped = (): undefined => {
      if (lanes.get(sessionId) === lane && lane.tail === tail && !lane.recountQueued) {
        lanes.delete(sessionId);
        account(sessionId);
      }
      return undefined;
    };
    const tail = turn.then(dropped, dropped);
    lane.tail = tail;
    return turn;
  }

  /**
   * Asks every provider what waits in a session.
   *
   * @remarks
   * Oldest first; a review that opened at the same time as another keeps the provider order.
   *
   * @sideEffects Asks the providers (they may run git).
   * @param sessionId - The session.
   * @returns Each review with the provider that raised it.
   */
  async function gather(
    sessionId: string,
  ): Promise<{ readonly review: PendingReview; readonly provider: ReviewProvider }[]> {
    const asked = await Promise.all(
      [...providers].map(async ({ provider }) =>
        (await provider.pending(sessionId, closing.signal)).map((review) => ({ review, provider })),
      ),
    );
    // The protocol takes no more than `REVIEWS_LIMIT` per session; the provider keeps to it, and this is the backstop.
    return asked
      .flat()
      .toSorted((a, b) => a.review.openedAt - b.review.openedAt)
      .slice(0, REVIEWS_LIMIT);
  }

  /**
   * Keeps a new count for a session and tells the listeners if it differs.
   *
   * @remarks
   * Compared as JSON: the reviews are plain data.
   *
   * @sideEffects May call the listeners.
   * @param sessionId - The session.
   * @param reviews - What waits in it now.
   */
  function keep(sessionId: string, reviews: readonly PendingReview[]): void {
    const before = known.get(sessionId);
    // Nothing waiting in a session nobody reads is nothing to remember.
    if (reviews.length === 0 && !reading.has(sessionId)) known.delete(sessionId);
    else known.set(sessionId, reviews);
    account(sessionId);
    if (before !== undefined && JSON.stringify(before) === JSON.stringify(reviews)) return;
    if (before === undefined && reviews.length === 0) return;
    for (const listener of listeners.keys()) {
      try {
        listener(sessionId);
      } catch (error) {
        options.logger.warn({ err: error instanceof Error ? error.name : "unknown" }, "review listener failed");
      }
    }
  }

  /**
   * Counts a session's reviews again, unless one is already waiting to start.
   *
   * @remarks
   * Many changes in a row (a task records an event per step) make one count after the last. A count that fails
   * is logged and leaves the last one standing.
   *
   * @sideEffects Asks the providers later; may call the listeners.
   * @param sessionId - The session.
   */
  function recount(sessionId: string): void {
    if (closing.signal.aborted) return;
    const lane = lanes.get(sessionId);
    if (lane?.recountQueued === true) return;
    /**
     * Counts the session's reviews, once its turn in the line comes.
     *
     * @remarks
     * Clears the "waiting" mark first, so a change that comes while the providers are asked queues one more count.
     *
     * @sideEffects Asks the providers; may call the listeners.
     */
    const work = async (): Promise<void> => {
      const queued = lanes.get(sessionId);
      if (queued !== undefined) queued.recountQueued = false;
      if (closing.signal.aborted) return;
      try {
        keep(
          sessionId,
          (await gather(sessionId)).map(({ review }) => review),
        );
      } catch (error) {
        if (!closing.signal.aborted) {
          options.logger.warn({ err: error instanceof Error ? error.name : "unknown" }, "reviews not counted");
        }
      }
    };
    void inLane(sessionId, work);
    const queued = lanes.get(sessionId);
    if (queued !== undefined) queued.recountQueued = true;
  }

  return {
    register(provider) {
      const release = options.resources.acquire("review.provider");
      const unsubscribe = provider.subscribe((sessionId) => recount(sessionId));
      const entry = {
        provider,
        stop: () => {
          unsubscribe();
          release();
        },
      };
      providers.add(entry);
      return () => {
        if (providers.delete(entry)) entry.stop();
      };
    },
    read(sessionId) {
      reading.add(sessionId);
      account(sessionId);
    },
    current(sessionId) {
      const found = known.get(sessionId);
      if (found !== undefined) return found;
      account(sessionId);
      recount(sessionId);
      return [];
    },
    refresh: (sessionId) => recount(sessionId),
    forget(sessionId) {
      reading.delete(sessionId);
      if ((known.get(sessionId) ?? []).length === 0) known.delete(sessionId);
      account(sessionId);
    },
    onChanged(listener) {
      const release = options.resources.acquire("review.listener");
      listeners.set(listener, release);
      return () => {
        if (listeners.delete(listener)) release();
      };
    },
    answer(sessionId, reviewId, verdict) {
      return inLane(sessionId, async () => {
        try {
          const found = (await gather(sessionId)).find(({ review }) => review.id === reviewId);
          if (found === undefined) throw new CommandError("review_closed", { reviewId });
          checkVerdict(found.review, verdict);
          await found.provider.decide(sessionId, found.review, verdict, closing.signal);
        } finally {
          // Whatever came of it, what waits has probably moved on; the listeners hear of it.
          if (!closing.signal.aborted) {
            keep(
              sessionId,
              await gather(sessionId).then(
                (all) => all.map(({ review }) => review),
                () => known.get(sessionId) ?? [],
              ),
            );
          }
        }
      });
    },
    async idle() {
      let lastTails: unknown[] = [];
      // New work may be queued by the work being awaited, so look until nothing is left.
      for (;;) {
        const tails = [...lanes.values()].map((lane) => lane.tail);
        if (tails.length === lastTails.length && tails.every((tail, index) => tail === lastTails[index])) return;
        lastTails = tails;
        await Promise.all(tails);
      }
    },
    async close() {
      closing.abort();
      for (const entry of providers) entry.stop();
      providers.clear();
      for (const lane of lanes.values()) await lane.tail;
      for (const release of listeners.values()) release();
      listeners.clear();
      known.clear();
      reading.clear();
      lanes.clear();
      for (const release of holding.values()) release();
      holding.clear();
    },
  };
}
