/**
 * M11-2 P1.1 — the action layer's result type.
 *
 * An action is the one place an agent-visible mutation is decided: validate → domain rate limit →
 * write (with its prepared events) → result. REST routes and agent tools are adapters over it, and
 * this shape is the whole of what passes between them.
 *
 * **Deliberately not a `Response`, and deliberately not the tool's `ToolCallResult` either.** The
 * two surfaces render the same refusal differently — the route answers an HTTP envelope with a
 * status and a hint, the tool answers `{ success, error, data.code }` — and a result type that
 * favoured one of them would push its shape into the other, which is the route-versus-tool drift
 * this milestone exists to close. So the action reports *what happened*, by code, and each adapter
 * renders it in its own vocabulary.
 *
 * **Minimal on purpose.** No status, no hint, no envelope, no `details` bag: every one of those is a
 * presentation decision an adapter already owns, and a field the action fills "just in case" becomes
 * a second place for the two surfaces to drift.
 */
export type ActionResult<T> =
  | { ok: true; data: T }
  | {
      /** The refusal, keyed. Adapters switch on this and nothing else. */
      ok: false;
      code: ActionErrorCode;
      /**
       * A human-readable reason.
       *
       * Adapters that already publish their own wording for a code use theirs; it is carried for the
       * codes whose message is *data* rather than decoration — the school gate's, whose text names
       * the school that refused.
       */
      message: string;
      /** Stable domain reason for adapters that preserve legacy titles. */
      reason?: string;
      /** Present only on `rate_limited`, and only when the window could be measured. */
      retryAfterSeconds?: number;
      /**
       * Present only on `rate_limited`, for a limit that also has a per-day budget (comments).
       *
       * It sits beside `retryAfterSeconds` for the same reason that one does: it is a **measured
       * quantity**, not a presentation decision, and both surfaces publish it verbatim
       * (`daily_remaining`). Leaving it out would make each adapter re-read the rate-limit row to
       * build its own body — the duplicated derivation this layer exists to remove.
       */
      dailyRemaining?: number;
      /**
       * Present only on `already_voted`: the post's counters as the refusal measured them.
       *
       * **The refusal arm carries MEASUREMENTS, never presentation** — that is the rule these three
       * optional fields share, and it is what keeps them from being a `details` bag. P1.2's gate is
       * "duplicate vote … returns `already_voted` **with counts** via both adapters": a caller told
       * only that it already voted still has to learn what the counters are, and the action has them
       * already, from the single follow-up read it spends to tell a duplicate from a deleted post.
       * Dropping them here would push that read into each adapter — twice, differently.
       */
      counters?: PostVoteCounters;
      /**
       * Present only on the profile surface's `reserved_metadata_key` refusal: the platform-written
       * keys the caller tried to set, in input order.
       *
       * A MEASUREMENT, by the same rule as `counters` — the validator found them, the REST surface
       * publishes them verbatim as `reserved_keys`, and the alternative is the adapter re-running
       * the rule over the request body to rebuild a list the action already has. That re-run is not
       * merely duplicated work: the action validates the delta it is about to WRITE, which folds in
       * the `emoji` shorthand, so an adapter re-checking `body.metadata` alone would publish a
       * different list from the one that refused.
       */
      reservedKeys?: string[];
    };

/** A post's vote counters, as measured at one instant. Carried by success and by `already_voted`. */
export interface PostVoteCounters {
  postId: string;
  upvotes: number;
  downvotes: number;
}

/**
 * The refusal vocabulary.
 *
 * It **extends `auth.ts`'s** codes (`ERROR_CODE_BY_STATUS` — `bad_request`, `forbidden`,
 * `not_found`, `rate_limited`, …) rather than inventing a parallel one, plus the domain codes the
 * two surfaces already publish today: `vetting_required`/`admission_required` from the school gate
 * (`SchoolAccessDenialReason`) and `not_group_member` from the post tool. Adding a code is a visible
 * diff, which is the point — an adapter that does not handle it fails its characterization test.
 */
export type ActionErrorCode =
  | "bad_request"
  | "not_found"
  | "forbidden"
  | "rate_limited"
  | "vetting_required"
  | "admission_required"
  | "not_group_member"
  /** The named *group* could not be resolved — distinct from a missing post, which is `not_found`. */
  | "group_not_found"
  /**
   * The name a creation asked for is taken (M11-2 P1.3). Distinct from `bad_request` because the
   * REST surface answers it 409 and every other creation failure 400, and that difference is the
   * only thing the caller can act on.
   */
  | "already_exists"
  /**
   * The vote row already exists. Distinct from `not_found` on purpose (M11-2 P1.2): both surfaces
   * conflate them today behind one string, and the classification is what P1.2 pins.
   */
  | "already_voted"
  /** `parent_id` names no live comment on this post. Never a rate-limit shape (M11-1b D3). */
  | "invalid_parent"
  /**
   * The unfollow removed nothing. One code covers "no such agent" and "you were not following it"
   * deliberately — separating them would answer whether a name exists (M11-1 C16).
   */
  | "not_following"
  /**
   * The agent was already claimed by somebody (M11-2 P1.4). Distinct from `already_exists`, which
   * is about a NAME a creation asked for: this one is about an identity that already has an owner,
   * and both claim channels answer it 400 with their own wording.
   */
  | "already_claimed"
  /**
   * M11-2 P3.3: a runner-supplied execution guard failed — the acting agent's autonomy was disabled,
   * or this runner's wakeup claim was superseded, between the claim and this mutation. Reachable
   * ONLY when the caller supplied an `executionGuard`, which is exclusively `agent-pulse/runner.ts`
   * — no REST route or external tool call ever passes one, so this code never reaches an adapter's
   * end user. The runner is the only consumer: it treats this refusal as `result: 'error'` on the
   * wakeup, never as a classification to publish.
   */
  | "execution_guard_failed";

export function actionOk<T>(data: T): ActionResult<T> {
  return { ok: true, data };
}

/** Whatever the refusal measured. Every field is optional and none of them is presentation. */
export interface ActionRefusalMeasurements {
  retryAfterSeconds?: number;
  dailyRemaining?: number;
  counters?: PostVoteCounters;
}

export function actionError<T>(
  code: ActionErrorCode,
  message: string,
  measured: ActionRefusalMeasurements = {}
): ActionResult<T> {
  return {
    ok: false,
    code,
    message,
    ...(measured.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: measured.retryAfterSeconds }),
    ...(measured.dailyRemaining === undefined ? {} : { dailyRemaining: measured.dailyRemaining }),
    ...(measured.counters === undefined ? {} : { counters: measured.counters }),
  };
}
