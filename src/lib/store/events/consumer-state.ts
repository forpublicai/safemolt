import { sql } from "@/lib/db";

/**
 * M11-2 P2.1 — the two pieces of per-consumer state that are neither cursor nor ledger: the shadow
 * comparison rows and memory ingest's recipient-progress ledger.
 *
 * **Database only, deliberately, and for two different reasons.**
 *
 *  - Shadow rows exist to be diffed against the legacy inline writer's production output during a
 *    soak. Memory mode has no soak, no `event_consumer_shadow` table, and no second writer to
 *    compare with, so `shadow` behaves as `legacy` there (`consumers/dispatch.ts`).
 *  - The progress ledger and the event claim exist because a drain can be interrupted mid-fan-out
 *    and RETRIED, and because two drain runtimes can reach the same event at once. Memory mode has
 *    no drain, no retries and no second runtime: the in-process dispatcher runs ingest once, on a
 *    fire-and-forget path, exactly as today's `waitUntil` schedulers do. A ledger with no retry to
 *    serve, and a claim with nobody to race, would be state nothing reads.
 *
 * Both live outside `db.ts` (the log) and `drain-db.ts` (the cursor/receipt/retry machinery)
 * because they belong to neither: they are the consumers' own storage.
 */

/**
 * One intended effect as the soak records it — the consumer's natural key, its content, and the
 * verdict of the comparison the dispatcher made against the legacy twin at DRAIN TIME (u4-prep).
 *
 * The stamp is not optional. A shadow row this build writes without one would be indistinguishable
 * from a row written before the comparison existed, and the report's whole verdict rests on that
 * distinction: a NULL stamp means "pre-amendment, never compared", and it must never be reachable
 * from code that could have compared and did not.
 */
export interface ShadowEffectRow {
  key: string;
  payload: Record<string, unknown>;
  legacyMatch: string;
  legacyDetail: Record<string, unknown> | null;
}

/**
 * Record what a consumer WOULD have written for one event, and how it compared.
 *
 * `ON CONFLICT DO NOTHING` because drains are concurrent and at-least-once — a crash before the
 * receipt replays the event — and duplicate shadow rows would corrupt the soak's mismatch counts.
 * A replay therefore adds nothing, which is what makes the comparison numbers mean something. The
 * FIRST pass's stamp is the one that survives, deliberately: it was taken closest to the write, and
 * a replay hours later would compare against a legacy row the world has moved past.
 *
 * One statement for the whole batch: the keys are unnested together rather than inserted in a loop,
 * so a fan-out of a thousand recipient-scoped ingest keys is one round trip and not a thousand.
 */
export async function recordConsumerShadowEffects(
  consumer: string,
  eventId: number,
  effects: readonly ShadowEffectRow[]
): Promise<void> {
  if (effects.length === 0) return;
  await sql!(
    `INSERT INTO event_consumer_shadow (consumer, event_id, effect_key, payload, legacy_match, legacy_detail)
     SELECT $1, $2, k, p::jsonb, m, d::jsonb
     FROM unnest($3::text[], $4::text[], $5::text[], $6::text[]) AS t(k, p, m, d)
     ON CONFLICT (consumer, event_id, effect_key) DO NOTHING`,
    [
      consumer,
      eventId,
      effects.map((effect) => effect.key),
      effects.map((effect) => JSON.stringify(effect.payload)),
      effects.map((effect) => effect.legacyMatch),
      effects.map((effect) => (effect.legacyDetail === null ? null : JSON.stringify(effect.legacyDetail))),
    ]
  );
}

const DEFAULT_INGEST_LEASE_MS = 600_000;

/**
 * The shortest lease this code honours.
 *
 * Below it a normal fan-out routinely outlives its own claim, so every event is attempted twice and
 * the ledger measures contention instead of progress. The gates override the lease deliberately and
 * go near this floor on purpose.
 */
const MIN_INGEST_LEASE_MS = 1_000;

/**
 * How long an event's fan-out claim is leased, and therefore how long a crashed owner blocks it.
 *
 * It must outlast one recipient's external vector work — an upsert, a subject re-check, a possible
 * compensating delete and a prune — but it does not have to outlast the WHOLE fan-out, because the
 * owner renews it while the work is outstanding. The default matches the drain's own event-level
 * claim lease. Env-tunable because the concurrency gates have to force a lapse deliberately, and a
 * ten-minute wait is not a test.
 */
export function ingestEventLeaseMs(): number {
  const raw = process.env.INGEST_EVENT_LEASE_MS?.trim();
  if (!raw) return DEFAULT_INGEST_LEASE_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < MIN_INGEST_LEASE_MS) return DEFAULT_INGEST_LEASE_MS;
  return parsed;
}

function leaseSeconds(): number {
  return ingestEventLeaseMs() / 1000;
}

/**
 * Which recipients of this event's fan-out are COMPLETE.
 *
 * **The event receipt is NOT the progress marker, and that is the whole reason this table exists.**
 * One ingest event fans out to up to 2,000 recipients processed sequentially with awaited external
 * vector work per recipient, and before the worker ships the five-minute drain route is the only
 * consumer runtime. A serverless timeout after recipient N would leave no receipt, and every retry
 * would restart at recipient 1 and could never reach the tail.
 *
 * A row is written at registration and finished later, so only `completed_at IS NOT NULL` is done.
 */
export async function listIngestProgressRecipients(eventId: number): Promise<Set<string>> {
  const rows = await sql!(
    `SELECT recipient_agent_id FROM ingest_progress
     WHERE event_id = $1 AND completed_at IS NOT NULL`,
    [eventId]
  );
  return new Set((rows as Array<{ recipient_agent_id: string }>).map((row) => row.recipient_agent_id));
}

/**
 * Take ownership of one event's WHOLE fan-out, or report that somebody else has it.
 *
 * ===================================================================================
 * **Fan-out ownership is singular per event, and that is a structural decision.**
 *
 * P2.1 tolerates concurrent drains redoing a recipient — "recipient effects are idempotent and
 * recorded once" — and that premise holds for a plain upsert of deterministic chunk ids. It stops
 * holding the moment the deletion COMPENSATION exists, because compensation is a delete and
 * delete-then-rewrite does not commute: a slow pass can land an upsert after a faster one already
 * compensated the same chunks away, leaving deleted content indexed behind a receipt nobody will
 * revisit.
 *
 * Guarding each recipient separately closes that one interleaving and opens others, because a
 * fan-out is not a set of independent recipients — it has a shared audience recompute, a shared
 * registration, and a shared completeness decision. Two passes holding different recipients of the
 * same event still disagree about what "finished" means. **One owner per event removes the class
 * rather than the instance:** a racing pass cannot recompute an audience, cannot register a
 * recipient, and cannot decide completeness, because it does not hold the claim.
 * ===================================================================================
 *
 * The conflict arm re-takes the claim only once the lease has lapsed, so a crashed owner blocks the
 * event for one lease and no longer. Zero rows back means another pass owns it right now.
 *
 * **A RECEIPT refuses the claim outright, and that closes the release-to-receipt gap.** A successful
 * pass returns, and the drain writes its receipt a moment later — those are two statements, and in
 * between the event is finished but not yet marked so. A second pass claiming in that window would
 * re-plan the fan-out, recompute an audience that may have changed, and start writing for
 * recipients the finished pass had already settled: work behind a completed event, whose failures
 * nothing would ever look at. So the successful owner deliberately does NOT release its claim (the
 * row is its "finished" marker until the receipt lands), and this statement refuses whenever a
 * receipt exists — which is what makes the leftover row harmless rather than a permanent block.
 * Those rows are collected by retention with their event, and opportunistically here.
 */
export async function claimIngestEvent(
  eventId: number,
  claimToken: string,
  consumer: string
): Promise<boolean> {
  const rows = await sql!(
    // The two arms are mutually exclusive by the same `receipted` predicate — the DELETE runs only
    // when a receipt exists and the INSERT only when one does not — so the statement never has two
    // data-modifying CTEs touching one row, which is the case Postgres leaves undefined.
    `WITH receipted AS (
       SELECT 1 FROM event_receipts WHERE consumer = $4 AND event_id = $1
     ), cleared AS (
       DELETE FROM ingest_event_claims
       WHERE event_id = $1 AND EXISTS (SELECT 1 FROM receipted)
       RETURNING event_id
     )
     INSERT INTO ingest_event_claims (event_id, claim_token, lease_expires_at)
     SELECT $1, $2, now() + make_interval(secs => $3::double precision)
     WHERE NOT EXISTS (SELECT 1 FROM receipted)
     ON CONFLICT (event_id) DO UPDATE
       SET claim_token = $2,
           lease_expires_at = now() + make_interval(secs => $3::double precision)
       WHERE ingest_event_claims.lease_expires_at <= now()
     RETURNING event_id`,
    [eventId, claimToken, leaseSeconds(), consumer]
  );
  return rows.length > 0;
}

/**
 * Extend this owner's claim on the event, fenced on the token.
 *
 * **A lease that is never renewed is a deadline nothing enforces.** External vector work has no
 * bound this process controls, so an owner whose lease lapsed mid-fan-out could keep writing while
 * another pass reclaimed the event and started compensating. Renewal turns the lease into a
 * heartbeat, and the moment this returns `false` the owner knows it is no longer the owner.
 *
 * @returns whether the caller still owned the event.
 */
export async function renewIngestEventLease(eventId: number, claimToken: string): Promise<boolean> {
  const rows = await sql!(
    // **`lease_expires_at > now()` is the half that makes this fail CLOSED.** A matching token is
    // not ownership: once the lease has lapsed the event is reclaimable, and a renewal without this
    // predicate would resurrect a claim the owner had already effectively lost — either racing a
    // drainer that is about to take it, or silently extending a hold over one that just did and
    // then had its own row overwritten. Renewal may only ever extend a lease that is still live.
    `UPDATE ingest_event_claims
     SET lease_expires_at = now() + make_interval(secs => $3::double precision)
     WHERE event_id = $1 AND claim_token = $2 AND lease_expires_at > now()
     RETURNING event_id`,
    [eventId, claimToken, leaseSeconds()]
  );
  return rows.length > 0;
}

/**
 * Hand the event back — on FAILURE exits only.
 *
 * A successful pass keeps its claim until the receipt lands (see `claimIngestEvent`): releasing it
 * would open a window in which the event is finished, unreceipted, and claimable, so a second pass
 * could start a whole fan-out behind a completed one. A failed pass has no such marker to leave and
 * releasing immediately is what lets the retry start without waiting out the lease.
 *
 * Fenced on the token, so an owner whose lease already lapsed releases nothing — the claim it would
 * be deleting belongs to whoever reclaimed the event. A crash without this is covered by the lease.
 */
export async function releaseIngestEvent(eventId: number, claimToken: string): Promise<void> {
  await sql!(`DELETE FROM ingest_event_claims WHERE event_id = $1 AND claim_token = $2`, [
    eventId,
    claimToken,
  ]);
}

/**
 * Register every recipient a pass has planned, before any of them is worked.
 *
 * **The row IS the durable recipient registration, and registering up front is what makes an event's
 * true audience visible to every pass.** Audiences are recomputed at consume time, so two passes can
 * legitimately plan different sets: a pass that recomputed without recipient R would otherwise see
 * only its own recipients, find them all complete, and report the fan-out finished while another
 * pass was still mid-flight on R. With R registered the moment any pass planned it, the completeness
 * check below sees it and refuses to let the event receipt.
 *
 * @returns whether the caller still owned the event when the rows were written.
 */
export async function registerIngestRecipients(
  eventId: number,
  recipientAgentIds: readonly string[],
  claimToken: string
): Promise<boolean> {
  const rows = await sql!(
    // **The ownership check is a LOCK inside the same statement, not a prior read.** A planner whose
    // lease lapsed while it was recomputing an audience could otherwise register recipients AFTER
    // its replacement had already checked completeness — or even after the event was receipted —
    // leaving rows nobody will ever settle. `FOR UPDATE` makes Postgres re-evaluate the token
    // against the row's current version, which a snapshot-evaluated `EXISTS` never does.
    `WITH owner AS (
       SELECT event_id FROM ingest_event_claims
       WHERE event_id = $1 AND claim_token = $3 AND lease_expires_at > now()
       FOR UPDATE
     ), registered AS (
       INSERT INTO ingest_progress (event_id, recipient_agent_id)
       SELECT o.event_id, t.r FROM owner o CROSS JOIN unnest($2::text[]) AS t(r)
       ON CONFLICT (event_id, recipient_agent_id) DO NOTHING
       RETURNING recipient_agent_id
     )
     SELECT count(*)::int AS owned FROM owner`,
    [eventId, [...recipientAgentIds], claimToken]
  );
  return Number((rows[0] as { owned: number }).owned) > 0;
}

/**
 * Every recipient of this event that is not finished.
 *
 * This is the completeness check the success path depends on: an event may only be reported done —
 * and therefore receipted — when this returns nothing. Under single-owner fan-out every row here was
 * written by a PAST owner that no longer exists, so there is nothing to wait on: the current owner
 * resolves each of them.
 */
export async function listIncompleteIngestRecipients(eventId: number): Promise<string[]> {
  const rows = await sql!(
    `SELECT recipient_agent_id FROM ingest_progress
     WHERE event_id = $1 AND completed_at IS NULL
     ORDER BY recipient_agent_id`,
    [eventId]
  );
  return (rows as Array<{ recipient_agent_id: string }>).map((row) => row.recipient_agent_id);
}

/**
 * Mark one recipient complete.
 *
 * Written AFTER the recipient's vector work and after any compensation, never before — a completion
 * written first would settle a recipient whose ingestion, or whose compensation, then failed.
 *
 * @returns whether the caller still owned the event. `false` means the lease lapsed, and the caller
 *   must treat that as a failure exit rather than as a settled recipient.
 */
export async function completeIngestRecipient(
  eventId: number,
  recipientAgentId: string,
  claimToken: string
): Promise<boolean> {
  const rows = await sql!(
    // Gated on the same locked, unexpired, token-matching claim as registration: an owner whose
    // lease lapsed mid-flight must not settle a recipient its replacement is still writing for.
    `WITH owner AS (
       SELECT event_id FROM ingest_event_claims
       WHERE event_id = $1 AND claim_token = $3 AND lease_expires_at > now()
       FOR UPDATE
     ), done AS (
       UPDATE ingest_progress p SET completed_at = now()
       FROM owner o
       WHERE p.event_id = o.event_id AND p.recipient_agent_id = $2 AND p.completed_at IS NULL
       RETURNING p.recipient_agent_id
     )
     SELECT count(*)::int AS owned FROM owner`,
    [eventId, recipientAgentId, claimToken]
  );
  return Number((rows[0] as { owned: number }).owned) > 0;
}
