/**
 * M11-2 P2.1 — the memory-ingest consumer.
 *
 * It replaces the five `schedule*MemoryIngest` call sites (inventory §9b); train a1 carries the two
 * content kinds, and the playground kinds follow in a2.
 *
 * **Consume-time semantics, decided in P2.1 and stated here so no reader has to infer them.** The
 * consumer re-fetches content by id and recomputes the audience at consume time: deleted content is
 * skipped, and an audience member who joined between the mutation and the consumption may be
 * included. That drift is accepted and documented, because ingest is best-effort background memory
 * — the alternative, snapshotting content and audiences into event payloads, is rejected for
 * privacy and retention reasons.
 *
 * **Fan-out progress is durable, and the event receipt is not the progress marker.** One ingest
 * event fans out to up to 2,000 recipients processed sequentially with awaited external vector work
 * per recipient. A serverless timeout after recipient N would leave no receipt, and every retry
 * would restart at recipient 1 and could never reach the tail. So each recipient is recorded in
 * `ingest_progress` as it completes, a retry resumes at the first unrecorded one, and `handleEvent`
 * returns successfully — letting the drain receipt — only once every recipient is recorded.
 */
import { createHash, randomUUID } from "crypto";

import { hasDatabase } from "@/lib/db";
import {
  buildCommentIngestChunks,
  buildPostIngestChunks,
  cleanupPostVectorsForRecipients,
  collectAgentIdsForCommentAudience,
  collectAgentIdsForPostAudience,
  commentIngestChunkStem,
  compensateRecipientBySubject,
  ingestChunksForRecipient,
  postIngestChunkStem,
  type PlatformIngestChunk,
} from "@/lib/memory/platform-ingest";
import {
  claimIngestEvent,
  completeIngestRecipient,
  getComment,
  getPost,
  ingestEventLeaseMs,
  listIncompleteIngestRecipients,
  listIngestProgressRecipients,
  registerIngestRecipients,
  releaseIngestEvent,
  renewIngestEventLease,
} from "@/lib/store";
import type { StoredEvent } from "@/lib/store-types";

import { RetryLaterError } from "../errors";
import { memoryIngestCoverage } from "./coverage";
import {
  defineConsumer,
  eventPayload,
  payloadId,
  payloadIdList,
  requireCorrelation,
  requiredNullablePayloadId,
  type ConsumerEffects,
  type RegisteredConsumer,
  type ShadowEffect,
} from "./dispatch";
import type { LegacyTwin } from "./legacy-compare";

const MEMORY_INGEST_CONSUMER = "memory-ingest";

/** Renewals per lease. Three leaves two chances to miss a tick before the claim could lapse. */
const LEASE_RENEWALS_PER_LEASE = 3;

/**
 * The per-attempt deadline, as a fraction of the lease.
 *
 * Strictly shorter than the lease, so an attempt that somehow stops renewing still stops working
 * before its claim could lapse under it and another attempt reclaim the recipient.
 */
const ATTEMPT_DEADLINE_FRACTION = 0.8;



/**
 * One event's fan-out: the identical chunks, every agent that should receive them, and the
 * subject-liveness re-check the compensation needs.
 */
interface PlannedIngest {
  recipients: string[];
  chunks: PlatformIngestChunk[];
  /** True while the content this ingest carries is still live. Re-read, never cached. */
  subjectIsLive(): Promise<boolean>;
}

/**
 * Effect keys are **recipient-scoped** — `{recipient_agent_id}:{chunk_id}` — because one chunk fans
 * out to every audience member and a chunk-id-only set cannot detect a missing recipient.
 */
function ingestEffectKey(recipientAgentId: string, chunkId: string): string {
  return `${recipientAgentId}:${chunkId}`;
}

/**
 * The audience, recomputed at CONSUME time — P2.1's decided semantics, with its residual named.
 *
 * The consumer re-fetches content by id and recomputes membership and followers when it drains, so
 * an agent who joined the group between the mutation and the consumption may be included and one
 * who left may not. That drift is accepted and documented; the alternative — snapshotting content
 * and audiences into event payloads — is rejected for privacy and retention reasons.
 *
 * **The orphan it implies is P1.1's already-accepted residual, and a crash window changes nothing
 * about it.** If a recipient is ingested and the pass dies before its progress row commits, and
 * that recipient has left the audience by the time the retry recomputes it, the retry receipts the
 * event without them and their copy stays. That is the same outcome the platform already has by
 * design: "an agent who received the post and later left the group retains the content in vector
 * memory — today's post-deletion cleanup semantics; closing it requires the ingest recipient ledger,
 * a named backlog item" (P1.1). Deletion cleanup keys off the delete-time payload
 * audience either way, so the crash adds no new class of unreachable vector — it reaches the same
 * state a plain membership change reaches on its own. The fuller per-recipient ledger that would
 * close it is the named backlog item, and THIS table is deliberately its foundation.
 */
async function planIngest(event: StoredEvent): Promise<PlannedIngest | null> {
  const payload = eventPayload(event);

  if (event.kind === "post.created") {
    const postId = payloadId(event, payload, "post_id");
    const post = await getPost(postId);
    if (!post) return null;
    const chunks = buildPostIngestChunks(post);
    if (chunks.length === 0) return null;
    return {
      recipients: await collectAgentIdsForPostAudience(post),
      chunks,
      // `getPost` hides a tombstone, so a non-null answer IS the liveness fact.
      subjectIsLive: async () => (await getPost(postId)) !== null,
    };
  }

  if (event.kind === "comment.created") {
    const commentId = payloadId(event, payload, "comment_id");
    const postId = payloadId(event, payload, "post_id");
    const comment = await getComment(commentId);
    if (!comment) return null;
    // **Correlation BEFORE liveness.** A comment that lives on another post would be ingested under
    // THIS post's title and fanned out to THIS post's audience — every read succeeding, nothing
    // raising — and checking liveness first would turn that contract error into a silent skip
    // whenever the wrongly-named post happened to be deleted. Two ids that disagree cannot be
    // reconciled by a retry, so this dead-letters either way.
    requireCorrelation(event, "post_id", postId, comment.postId);
    requireCorrelation(
      event,
      "parent_id",
      requiredNullablePayloadId(event, payload, "parent_id"),
      comment.parentId ?? null
    );
    const post = await getPost(postId);
    if (!post) return null;
    const chunks = buildCommentIngestChunks(comment, post);
    if (chunks.length === 0) return null;
    return {
      recipients: await collectAgentIdsForCommentAudience(comment, post),
      chunks,
      // `getComment` joins its post and hides the thread of a deleted one, so this single read
      // covers BOTH subjects: the comment itself and the parent post it was ingested under.
      subjectIsLive: async () => (await getComment(commentId)) !== null,
    };
  }

  return null;
}

/** The audience a `post.deleted` cleanup spends: the payload's, because nothing is recomputable. */
function plannedCleanupRecipients(event: StoredEvent): { postId: string; recipients: string[] } {
  const payload = eventPayload(event);
  return {
    postId: payloadId(event, payload, "post_id"),
    recipients: Array.from(
      new Set([
        ...payloadIdList(event, payload, "audience_agent_ids"),
        ...payloadIdList(event, payload, "commenter_ids"),
      ])
    ),
  };
}

/**
 * The lease keeper: renew the EVENT claim while external work is outstanding, and refuse to keep
 * writing once ownership is lost.
 *
 * **A lease that is never renewed is a deadline nothing enforces.** The vector service has no bound
 * this process controls, so a slow owner could straddle another pass's reclaim and land a write
 * after that pass had already compensated chunks away. Renewing turns the claim into a heartbeat,
 * and a renewal that reports `false` is this pass learning it is no longer the owner — after which
 * it must not write, must not compensate, and must not complete anything.
 *
 * **The unavoidable cross-system residual, stated plainly:** the vector client exposes no
 * cancellation, so a request already in flight when ownership is lost may still be applied by the
 * provider. Nothing in this process can prevent that — the write has left. What this bounds is
 * everything under our control: no NEW external call, no compensation over the new owner's chunks,
 * and no completion. The new owner's own re-check and compensation converge the recipient
 * afterwards, and the deadline keeps the exposure to one call rather than one lease.
 */
function startEventLeaseKeeper(eventId: number, claimToken: string, claimRequestedAt: number) {
  const leaseMs = ingestEventLeaseMs();
  let lost: Error | null = null;
  /**
   * When ownership was last CONFIRMED, stamped from when the request was SENT — never from when its
   * response arrived.
   *
   * The database starts the lease window when it processes the statement, so a response that took
   * two seconds to come back confirms a window that began two seconds ago. Stamping on arrival would
   * push the local deadline past the real one by exactly the round-trip time, which is largest
   * precisely when the database is struggling and the lease is most likely to be lapsing. The claim
   * that opened this keeper is the first such confirmation, and its own request time is passed in.
   */
  let lastConfirmedAt = claimRequestedAt;

  const markLost = (reason: string) => {
    if (!lost) lost = new Error(`[memory-ingest] event ${eventId}: ${reason}`);
  };

  const renewTimer = setInterval(() => {
    const requestedAt = Date.now();
    void renewIngestEventLease(eventId, claimToken)
      .then((owned) => {
        // `Math.max`, so a response that arrives out of order cannot move the confirmation backwards.
        if (owned) lastConfirmedAt = Math.max(lastConfirmedAt, requestedAt);
        else markLost("lost the fan-out claim");
      })
      // **A failed renewal CALL is treated as a lost claim, deliberately — this fails CLOSED.** An
      // unreachable database is exactly the condition under which the lease is quietly expiring and
      // another drainer is about to reclaim the event, and "the next tick will retry" is a bet that
      // costs a duplicate owner when it loses. Aborting costs one retry of a pass that was going to
      // be retried anyway.
      .catch(() => markLost("lost the fan-out claim: renewal failed"));
  }, Math.max(250, Math.floor(leaseMs / LEASE_RENEWALS_PER_LEASE)));

  // A per-pass deadline strictly shorter than the lease — and firing it STOPS THE RENEWALS, which
  // is the half that matters. A hung vector call would otherwise be renewed forever: the pass never
  // returns, the lease never lapses, and the event becomes permanently unreclaimable by anyone.
  // Stopping the heartbeat lets the lease expire on its own, so the next pass can take the event
  // even though this one is still stuck inside a call nothing can cancel.
  const deadlineTimer = setTimeout(() => {
    markLost("fan-out exceeded its deadline");
    clearInterval(renewTimer);
  }, Math.max(500, Math.floor(leaseMs * ATTEMPT_DEADLINE_FRACTION)));

  return {
    /** The claim this keeper renews. Every ledger write is fenced on it. */
    token: claimToken,
    /**
     * Throws once ownership is gone. Asserted between external calls.
     *
     * **Cached state is not enough, so this also enforces a local expiry.** The flag above is only
     * as current as the last renewal that ran; a starved event loop, a suspended process or a timer
     * that never fired would leave it saying `owned` long after the database lease lapsed and
     * somebody else took the event. Ownership is therefore trusted only while the last CONFIRMED
     * renewal is younger than the lease window — the same window the database is measuring.
     */
    assertOwned(): void {
      if (!lost && Date.now() - lastConfirmedAt >= leaseMs) {
        markLost("lost the fan-out claim: lease window elapsed with no confirmed renewal");
      }
      if (lost) throw lost;
    },
    /** The same, as a store-report: `false` from a fenced write means the lease lapsed. */
    requireOwned(owned: boolean, what: string): void {
      if (!owned) {
        throw new Error(`[memory-ingest] event ${eventId}: lost the fan-out claim during ${what}`);
      }
    },
    stop(): void {
      clearInterval(renewTimer);
      clearTimeout(deadlineTimer);
    },
  };
}

type LeaseKeeper = ReturnType<typeof startEventLeaseKeeper>;

/**
 * Resolve every registered recipient that is not yet complete.
 *
 * Two shapes, and the second is the one a "plan is null" shortcut used to miss. When the subject is
 * still live the recipient is re-ingested (or, if they have left the recomputed audience, their
 * chunks are compensated away). When the subject is a TOMBSTONE there is nothing to re-ingest and
 * `planIngest` returns null — but a previous pass may have written chunks for exactly these
 * recipients and then died, so returning success there would receipt the event over a late write
 * nobody will ever look at again. The tombstone branch compensates by the payload-derived subject
 * predicate instead, then completes the row.
 */
async function resolveOutstandingRecipients(
  event: StoredEvent,
  planned: PlannedIngest | null,
  keeper: LeaseKeeper
): Promise<void> {
  const outstanding = await listIncompleteIngestRecipients(event.id);
  if (outstanding.length === 0) return;
  const inAudience = new Set(planned?.recipients ?? []);

  for (const recipientAgentId of outstanding) {
    if (planned && inAudience.has(recipientAgentId)) {
      await ingestOneRecipient(event.id, recipientAgentId, planned, keeper);
      continue;
    }
    // Departed from the audience, or the subject is gone entirely: remove whatever a previous pass
    // may have written for them, under the subject predicate the payload still names.
    await compensateRecipientBySubject(recipientAgentId, subjectVectorPredicate(event), () =>
      keeper.assertOwned()
    );
    keeper.assertOwned();
    keeper.requireOwned(
      await completeIngestRecipient(event.id, recipientAgentId, keeper.token),
      "tombstone completion"
    );
  }
}

/**
 * The metadata predicate identifying everything this event's content wrote for one recipient.
 *
 * **A predicate, not a chunk-id list, and the reason is arithmetic.** The chunk ids are
 * deterministic per (subject, index) but the INDEX depends on the content's length, and by the time
 * a tombstone is being resolved the content is gone — so a stem is derivable and the ids are not,
 * and the vector API offers no prefix scan. The metadata each chunk carries names its subject
 * exactly, which is the same anchor `post.deleted`'s cleanup uses, and it is payload-derived rather
 * than read from live state.
 */
function subjectVectorPredicate(event: StoredEvent): Record<string, string> {
  const payload = eventPayload(event);
  return event.kind === "comment.created"
    ? { comment_id: payloadId(event, payload, "comment_id") }
    : { post_id: payloadId(event, payload, "post_id") };
}

/**
 * One recipient's share, under the event owner's lease.
 *
 * The write, the subject re-check and the compensation live in `ingestChunksForRecipient`, shared
 * with the reconciliation and the route schedulers. What this adds is the ownership fence around
 * them and the completion afterwards — never before, so a recipient whose ingestion, compensation
 * or prune failed stays incomplete and is retried.
 */
async function ingestOneRecipient(
  eventId: number,
  recipientAgentId: string,
  planned: PlannedIngest,
  keeper: LeaseKeeper
): Promise<void> {
  await ingestChunksForRecipient(recipientAgentId, planned.chunks, {
    subjectIsLive: planned.subjectIsLive,
    assertStillOwned: () => keeper.assertOwned(),
  });
  keeper.assertOwned();
  keeper.requireOwned(
    await completeIngestRecipient(eventId, recipientAgentId, keeper.token),
    "completion"
  );
}

/**
 * Run the whole fan-out as the event's single owner.
 *
 * Returns only when EVERY registered recipient of the event is complete; a failure propagates,
 * leaving the event unreceipted with its ledger rows intact so the next owner resumes here.
 *
 * **A racing pass cannot register a recipient, so completeness means completeness.** Audiences are
 * recomputed at consume time and two passes can legitimately plan different sets — but only the
 * claim holder ever recomputes, registers, or decides. Everything this reads was written by a past
 * owner that no longer exists, so there is nothing in flight to wait on: it is resolved.
 */
/**
 * The `post.deleted` cleanup, run through the SAME ledger as an ingest fan-out.
 *
 * **It used to be a best-effort sweep, and that was a hole a receipt made permanent.** The wrapper
 * it called swallows a per-recipient failure so one unreachable recipient does not cost every later
 * one its cleanup — correct for the inline call site, which has no retry — but here the drain
 * receipts whatever returns, so a swallowed failure meant a deleted post's vectors stayed indexed
 * for that agent forever, behind a receipt nothing revisits.
 *
 * So the payload's audience is registered like any other fan-out, each recipient's cleanup THROWS,
 * only the ones that succeed are completed, and this returns only once none are outstanding — which
 * includes recipients a previous pass registered and never finished.
 */
async function runOwnedCleanup(event: StoredEvent, keeper: LeaseKeeper): Promise<void> {
  const { postId, recipients } = plannedCleanupRecipients(event);
  keeper.requireOwned(
    await registerIngestRecipients(event.id, recipients, keeper.token),
    "cleanup registration"
  );

  // Everything registered and unfinished — this pass's audience plus any leftovers from a pass that
  // died part-way. The payload's audience is fixed, so both sets are cleaned the same way.
  for (const recipientAgentId of await listIncompleteIngestRecipients(event.id)) {
    await compensateRecipientBySubject(recipientAgentId, { post_id: postId }, () =>
      keeper.assertOwned()
    );
    keeper.assertOwned();
    keeper.requireOwned(
      await completeIngestRecipient(event.id, recipientAgentId, keeper.token),
      "cleanup completion"
    );
  }
}

async function runOwnedFanOut(
  event: StoredEvent,
  planned: PlannedIngest | null,
  keeper: LeaseKeeper
): Promise<void> {
  if (planned) {
    // Fenced: a planner whose lease lapsed while it recomputed the audience must not register
    // recipients behind its replacement's completeness check — or behind the receipt.
    keeper.requireOwned(
      await registerIngestRecipients(event.id, planned.recipients, keeper.token),
      "registration"
    );
    const done = await listIngestProgressRecipients(event.id);
    for (const recipientAgentId of planned.recipients) {
      if (done.has(recipientAgentId)) continue;
      await ingestOneRecipient(event.id, recipientAgentId, planned, keeper);
    }
  }
  // Rows a previous owner registered and never finished — including, when the subject is now a
  // tombstone, every row of a fan-out that has no live content left to send.
  await resolveOutstandingRecipients(event, planned, keeper);
}

/**
 * The effects, exported beside the consumer — see the note in `notifications.ts`: every checked-in
 * manifest is `legacy` or `none` in u2, so the gates drive these directly with synthetic events and
 * build forced-`on` registry copies from them.
 */
export const memoryIngestEffects: ConsumerEffects = {
  async describe(event: StoredEvent): Promise<ShadowEffect[]> {
    if (event.kind === "post.deleted") {
      // **KEY-ONLY, per recipient per SUBJECT, derived from the payload.**
      //
      // Two constraints shape this. The chunk ids are deterministic stems — `plat_post_{post_id}_c`
      // and `plat_cmt_{comment_id}_c` — but the trailing chunk INDEX depends on the content's
      // length, and the content is gone by the time this runs, so no id-exact key set is derivable.
      // And the ids must come from the payload rather than from the vector store: in the deployed
      // ordering the legacy cleanup runs FIRST and this event drains afterwards, so a live listing
      // describes an empty set on every real deletion and the soak reads clean while proving
      // nothing.
      //
      // The stem per recipient per subject is what IS derivable, and it is strictly more than a
      // blob: it names which recipients lose which subjects' vectors. There is no canonical payload
      // to compare — the chunks are gone — so the flip precondition for this kind is the both-orders
      // convergence gates rather than a payload diff (see `coverage.ts`).
      const { postId, recipients } = plannedCleanupRecipients(event);
      const commentIds = payloadIdList(event, eventPayload(event), "comment_ids");
      const stems = [postIngestChunkStem(postId), ...commentIds.map(commentIngestChunkStem)];
      return recipients.flatMap((recipientAgentId) =>
        stems.map((stem) => ({
          key: ingestEffectKey(recipientAgentId, stem),
          payload: {
            operation: "delete",
            recipient_agent_id: recipientAgentId,
            chunk_id_stem: stem,
            post_id: postId,
          },
        }))
      );
    }

    const planned = await planIngest(event);
    if (!planned) return [];
    const rows: ShadowEffect[] = [];
    for (const recipientAgentId of planned.recipients) {
      for (const chunk of planned.chunks) {
        rows.push({
          key: ingestEffectKey(recipientAgentId, chunk.id),
          payload: {
            recipient_agent_id: recipientAgentId,
            chunk_id: chunk.id,
            // Recipient + source-text HASH + metadata, which is exactly what P2.1 says the soak
            // compares. The text itself is never recorded: a shadow table must not become a second,
            // undeletable copy of platform content. Provider-generated embeddings are excluded by
            // construction — nothing in `describe` calls the vector service.
            text_sha256: createHash("sha256").update(chunk.text).digest("hex"),
            metadata: chunk.metadata,
          },
        });
      }
    }
    return rows;
  },

  /**
   * There is no legacy twin to read, for ANY kind (u4-prep).
   *
   * The legacy effect of this consumer lives in an external vector provider with no Postgres table,
   * so every row it writes stamps `unverifiable` and is excluded from the soak's flip-clean verdict.
   * Stating that per row rather than leaving the column NULL is the point: a NULL means "written
   * before the comparison existed", and an ingest row that read as merely un-compared would be
   * indistinguishable from a stamping regression. Closing this needs a provider-backed key/payload
   * export — a named backlog item, not built here.
   */
  async readLegacyTwin(): Promise<LegacyTwin> {
    return {
      state: "unverifiable",
      reason: "memory ingest's legacy effect lives in an external vector provider, not in SQL",
    };
  },

  async apply(event: StoredEvent): Promise<void> {
    // **The ledger and the claim are database-only, and their absence in memory mode is correct
    // rather than a gap.** Memory mode has no drain and therefore no retry and no second runtime:
    // the in-process dispatcher runs this once, on a fire-and-forget path, exactly as today's
    // `waitUntil` schedulers do. A ledger with no retry to serve, and a claim with nobody to race,
    // would be state nothing ever reads. The subject re-check and the compensation still apply —
    // they live inside `ingestChunksForRecipient` and guard the vector store being outside the
    // transaction, which has nothing to do with retries.
    if (!hasDatabase()) {
      if (event.kind === "post.deleted") {
        const { postId, recipients } = plannedCleanupRecipients(event);
        await cleanupPostVectorsForRecipients(postId, recipients);
        return;
      }
      const planned = await planIngest(event);
      if (!planned) return;
      for (const recipientAgentId of planned.recipients) {
        await ingestChunksForRecipient(recipientAgentId, planned.chunks, {
          subjectIsLive: planned.subjectIsLive,
        });
      }
      return;
    }

    // **The claim comes FIRST — before any content read, any audience recompute, any registration.**
    // One owner does all of it, so a racing pass cannot register a recipient this pass will not see,
    // and "every registered recipient is complete" therefore means what it says. Reading content
    // before claiming would not corrupt anything, but it would let a pass that is about to be
    // refused spend the reads anyway.
    //
    // **The claim is released on FAILURE only.** A successful pass returns and the drain writes its
    // receipt a moment later; those are two statements, and a second pass claiming in between would
    // start a whole fan-out behind an event that is already finished — re-planning against an
    // audience that may have changed, writing for recipients the finished pass had settled, and
    // failing where nothing would ever look. Keeping the claim makes that window unclaimable, and
    // `claimIngestEvent` refuses once the receipt exists, so the leftover row blocks nothing.
    const claimToken = randomUUID();
    // Stamped BEFORE the request: the lease window starts when the database processes it, not when
    // the answer gets back here. See `startEventLeaseKeeper`.
    const claimRequestedAt = Date.now();
    if (!(await claimIngestEvent(event.id, claimToken, MEMORY_INGEST_CONSUMER))) {
      // **`RetryLaterError`, not a plain error: contention is not failure.** A generic throw would
      // open a failures row, count an attempt and pace the next one — and three refusals fit inside
      // one owner's lease, at which point this loser would dead-letter and RECEIPT an event whose
      // owner is still working. The sentinel makes the drain skip the event for this pass only.
      throw new RetryLaterError(
        `[memory-ingest] event ${event.id}: fan-out owned by another pass, or already receipted`
      );
    }

    const keeper = startEventLeaseKeeper(event.id, claimToken, claimRequestedAt);
    let succeeded = false;
    try {
      if (event.kind === "post.deleted") await runOwnedCleanup(event, keeper);
      else await runOwnedFanOut(event, await planIngest(event), keeper);
      // **The last assertion, and it covers the ZERO-WORK paths.** A tombstoned subject with no
      // outstanding recipients, or a fan-out whose recipients were all already complete, performs no
      // external call and therefore passes no `assertOwned` on its way here — so a renewal that
      // failed during those reads would otherwise let this pass report success, and the drain would
      // receipt an event whose new owner is still working.
      keeper.assertOwned();
      succeeded = true;
    } finally {
      keeper.stop();
      if (!succeeded) await releaseIngestEvent(event.id, claimToken).catch(() => {});
    }
  },
};

export const memoryIngestConsumer: RegisteredConsumer = defineConsumer({
  name: MEMORY_INGEST_CONSUMER,
  coverage: memoryIngestCoverage,
  effects: memoryIngestEffects,
  // Deliberately NOT awaited in memory mode: ingest is fire-and-forget today (`waitUntil` at the
  // post and comment routes) with sequential awaited vector work for up to 2,000 recipients, so
  // awaiting it inline would turn a local no-DB post into a minutes-long call dependent on external
  // vector availability — the opposite of preserving current behavior.
  memoryModeDelivery: "background",
});
