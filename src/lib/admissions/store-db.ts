/**
 * Postgres implementation of admissions (cycles, applications, offers, audit).
 */
import { sql } from "@/lib/db";
import type { NeonQueryFunctionInTransaction } from "@neondatabase/serverless";
import type {
  AdmissionsApplicationState,
  AdmissionsCycleStatus,
  AdmissionsOfferStatus,
  StoredAdmissionsApplication,
  StoredAdmissionsCycle,
  StoredAdmissionsOffer,
} from "./types";
import { getAgentById } from "@/lib/store";

function genId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function rowCycle(r: Record<string, unknown>): StoredAdmissionsCycle {
  return {
    id: r.id as string,
    name: r.name as string,
    opensAt: r.opens_at instanceof Date ? r.opens_at.toISOString() : String(r.opens_at),
    closesAt: r.closes_at ? (r.closes_at instanceof Date ? r.closes_at.toISOString() : String(r.closes_at)) : null,
    targetSize: r.target_size != null ? Number(r.target_size) : null,
    maxOffers: r.max_offers != null ? Number(r.max_offers) : null,
    status: r.status as AdmissionsCycleStatus,
    diversityNotes: (r.diversity_notes as string) ?? null,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
  };
}

function rowApp(r: Record<string, unknown>): StoredAdmissionsApplication {
  return {
    id: r.id as string,
    agentId: r.agent_id as string,
    cycleId: r.cycle_id as string,
    state: r.state as AdmissionsApplicationState,
    primaryDomain: (r.primary_domain as string) ?? null,
    nonGoals: (r.non_goals as string) ?? null,
    evaluationPlan: (r.evaluation_plan as string) ?? null,
    dedupeSimilarityScore: r.dedupe_similarity_score != null ? Number(r.dedupe_similarity_score) : null,
    dedupeFlagged: Boolean(r.dedupe_flagged),
    autoShortlistOk: Boolean(r.auto_shortlist_ok),
    rejectReasonCategory: (r.reject_reason_category as StoredAdmissionsApplication["rejectReasonCategory"]) ?? null,
    reviewerNotesInternal: (r.reviewer_notes_internal as string) ?? null,
    decidedAt: r.decided_at
      ? r.decided_at instanceof Date
        ? r.decided_at.toISOString()
        : String(r.decided_at)
      : null,
    poolEnteredAt: r.pool_entered_at instanceof Date ? r.pool_entered_at.toISOString() : String(r.pool_entered_at),
    updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at),
  };
}

function rowOffer(r: Record<string, unknown>): StoredAdmissionsOffer {
  const payload = r.payload_json;
  return {
    id: r.id as string,
    agentId: r.agent_id as string,
    cycleId: r.cycle_id as string,
    applicationId: (r.application_id as string) ?? null,
    status: r.status as AdmissionsOfferStatus,
    offerVersion: Number(r.offer_version),
    payloadJson:
      payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {},
    expiresAt: r.expires_at instanceof Date ? r.expires_at.toISOString() : String(r.expires_at),
    createdByStaffHumanId: (r.created_by_staff_human_id as string) ?? null,
    acceptedAtAgent: r.accepted_at_agent
      ? r.accepted_at_agent instanceof Date
        ? r.accepted_at_agent.toISOString()
        : String(r.accepted_at_agent)
      : null,
    acceptedAtHuman: r.accepted_at_human
      ? r.accepted_at_human instanceof Date
        ? r.accepted_at_human.toISOString()
        : String(r.accepted_at_human)
      : null,
    acceptedHumanUserId: (r.accepted_human_user_id as string) ?? null,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
  };
}

export async function refreshExpiredOffersDb(): Promise<void> {
  // One statement, atomic by definition. The Neon HTTP driver gives every
  // standalone sql`` call its own connection, so the previous
  // BEGIN / read / loop-of-UPDATEs / COMMIT sequence shared no session and
  // protected nothing (the same non-pattern C1/C11 removed elsewhere).
  await sql!`
    WITH expired AS (
      UPDATE admissions_offers
      SET status = 'expired'
      WHERE status = 'pending' AND expires_at < NOW()
      RETURNING application_id
    )
    UPDATE admissions_applications a
    SET state = 'in_pool', updated_at = NOW()
    FROM expired e
    WHERE a.id = e.application_id AND a.state = 'offered'
      -- M11-1b D6: only release an application with NO OTHER live offer. Pre-D6 data can carry two
      -- pending offers on one application; expiring the lapsed one and releasing the application
      -- anyway would leave it in_pool while a live offer still stands.
      AND NOT EXISTS (
        SELECT 1 FROM admissions_offers o2
        WHERE o2.application_id = a.id AND o2.status = 'pending' AND o2.expires_at >= NOW()
      )
  `;
}

export async function getDefaultOpenCycleIdDb(): Promise<string | null> {
  const rows = await sql!`
    SELECT id FROM admissions_cycles WHERE status = 'open' ORDER BY opens_at DESC LIMIT 1
  `;
  const r = rows[0] as { id: string } | undefined;
  return r?.id ?? null;
}

export async function getCycleDb(id: string): Promise<StoredAdmissionsCycle | null> {
  const rows = await sql!`SELECT * FROM admissions_cycles WHERE id = ${id} LIMIT 1`;
  const r = rows[0] as Record<string, unknown> | undefined;
  return r ? rowCycle(r) : null;
}

export async function listCyclesDb(): Promise<StoredAdmissionsCycle[]> {
  const rows = await sql!`SELECT * FROM admissions_cycles ORDER BY opens_at DESC`;
  return (rows as Record<string, unknown>[]).map(rowCycle);
}

export async function createCycleDb(input: {
  id?: string;
  name: string;
  opensAtIso: string;
  closesAtIso?: string | null;
  targetSize?: number | null;
  maxOffers?: number | null;
  status?: AdmissionsCycleStatus;
  diversityNotes?: string | null;
}): Promise<StoredAdmissionsCycle> {
  const id = input.id ?? genId("admcy");
  await sql!`
    INSERT INTO admissions_cycles (id, name, opens_at, closes_at, target_size, max_offers, status, diversity_notes)
    VALUES (
      ${id}, ${input.name}, ${input.opensAtIso}, ${input.closesAtIso ?? null},
      ${input.targetSize ?? null}, ${input.maxOffers ?? null},
      ${input.status ?? "open"}, ${input.diversityNotes ?? null}
    )
  `;
  const c = await getCycleDb(id);
  if (!c) throw new Error("cycle_create_failed");
  return c;
}

export async function getApplicationByAgentCycleDb(
  agentId: string,
  cycleId: string
): Promise<StoredAdmissionsApplication | null> {
  const rows = await sql!`
    SELECT * FROM admissions_applications WHERE agent_id = ${agentId} AND cycle_id = ${cycleId} LIMIT 1
  `;
  const r = rows[0] as Record<string, unknown> | undefined;
  return r ? rowApp(r) : null;
}

export async function getApplicationByIdDb(id: string): Promise<StoredAdmissionsApplication | null> {
  const rows = await sql!`SELECT * FROM admissions_applications WHERE id = ${id} LIMIT 1`;
  const r = rows[0] as Record<string, unknown> | undefined;
  return r ? rowApp(r) : null;
}

export async function ensureApplicationInPoolDb(agentId: string, cycleId: string): Promise<StoredAdmissionsApplication> {
  const agent = await getAgentById(agentId);
  if (!agent) throw new Error("agent_not_found");
  if (agent.isAdmitted) throw new Error("already_admitted");

  const existing = await getApplicationByAgentCycleDb(agentId, cycleId);
  if (existing) return existing;

  const id = genId("admapp");
  await sql!`
    INSERT INTO admissions_applications (id, agent_id, cycle_id, state, pool_entered_at, updated_at)
    VALUES (${id}, ${agentId}, ${cycleId}, 'in_pool', NOW(), NOW())
  `;
  const created = await getApplicationByIdDb(id);
  if (!created) throw new Error("application_create_failed");
  return created;
}

export async function listApplicationsForStaffDb(
  cycleId: string,
  states?: AdmissionsApplicationState[]
): Promise<StoredAdmissionsApplication[]> {
  const rows = await sql!`
    SELECT * FROM admissions_applications WHERE cycle_id = ${cycleId} ORDER BY pool_entered_at ASC
  `;
  let list = (rows as Record<string, unknown>[]).map(rowApp);
  if (states && states.length > 0) {
    list = list.filter((a) => states.includes(a.state));
  }
  return list;
}

export async function transitionApplicationStateDb(
  applicationId: string,
  newState: AdmissionsApplicationState,
  reviewerNotesInternal?: string | null,
  rejectReasonCategory?: string | null
): Promise<StoredAdmissionsApplication | null> {
  const decidedAt =
    newState === "rejected" || newState === "admitted" ? new Date().toISOString() : null;
  await sql!`
    UPDATE admissions_applications
    SET state = ${newState},
        updated_at = NOW(),
        reviewer_notes_internal = COALESCE(${reviewerNotesInternal ?? null}, reviewer_notes_internal),
        reject_reason_category = COALESCE(${rejectReasonCategory ?? null}, reject_reason_category),
        decided_at = COALESCE(${decidedAt}, decided_at)
    WHERE id = ${applicationId}
  `;
  return getApplicationByIdDb(applicationId);
}

export async function updateApplicationNicheDb(
  applicationId: string,
  fields: {
    primaryDomain?: string | null;
    nonGoals?: string | null;
    evaluationPlan?: string | null;
  }
): Promise<StoredAdmissionsApplication | null> {
  const cur = await getApplicationByIdDb(applicationId);
  if (!cur) return null;
  const pd = fields.primaryDomain !== undefined ? fields.primaryDomain : cur.primaryDomain;
  const ng = fields.nonGoals !== undefined ? fields.nonGoals : cur.nonGoals;
  const ep = fields.evaluationPlan !== undefined ? fields.evaluationPlan : cur.evaluationPlan;
  await sql!`
    UPDATE admissions_applications
    SET primary_domain = ${pd},
        non_goals = ${ng},
        evaluation_plan = ${ep},
        updated_at = NOW()
    WHERE id = ${applicationId}
  `;
  return getApplicationByIdDb(applicationId);
}

export async function updateApplicationDedupeDb(
  applicationId: string,
  patch: { dedupeSimilarityScore?: number | null; dedupeFlagged?: boolean }
): Promise<StoredAdmissionsApplication | null> {
  const cur = await getApplicationByIdDb(applicationId);
  if (!cur) return null;
  const score = patch.dedupeSimilarityScore !== undefined ? patch.dedupeSimilarityScore : cur.dedupeSimilarityScore;
  const flagged = patch.dedupeFlagged !== undefined ? patch.dedupeFlagged : cur.dedupeFlagged;
  await sql!`
    UPDATE admissions_applications
    SET dedupe_similarity_score = ${score},
        dedupe_flagged = ${flagged},
        updated_at = NOW()
    WHERE id = ${applicationId}
  `;
  return getApplicationByIdDb(applicationId);
}

export async function setApplicationAutoShortlistDb(applicationId: string, ok: boolean): Promise<void> {
  await sql!`
    UPDATE admissions_applications SET auto_shortlist_ok = ${ok}, updated_at = NOW() WHERE id = ${applicationId}
  `;
}

export async function runAutoShortlistHeuristicDb(cycleId: string): Promise<number> {
  const apps = await listApplicationsForStaffDb(cycleId, ["under_review", "in_pool"]);
  let n = 0;
  for (const a of apps) {
    const domainLen = (a.primaryDomain ?? "").trim().length;
    if (domainLen >= 8) {
      await setApplicationAutoShortlistDb(a.id, true);
      n++;
    }
  }
  return n;
}

export async function countPendingOffersInCycleDb(cycleId: string): Promise<number> {
  const rows = await sql!`
    SELECT COUNT(*)::int AS c FROM admissions_offers WHERE cycle_id = ${cycleId} AND status = 'pending'
  `;
  return Number((rows[0] as { c: number }).c);
}

export async function getPendingOfferForAgentDb(agentId: string): Promise<StoredAdmissionsOffer | null> {
  const rows = await sql!`
    SELECT * FROM admissions_offers
    WHERE agent_id = ${agentId} AND status = 'pending' AND expires_at >= NOW()
    ORDER BY created_at DESC
    LIMIT 1
  `;
  const r = rows[0] as Record<string, unknown> | undefined;
  return r ? rowOffer(r) : null;
}

/**
 * M11-1b D6 — staff offer creation, atomic and cap-correct.
 *
 * **Why this is a batch and not one statement, which is the whole point of the chunk.** The cap is
 * cycle-wide, so it can only be serialized on the cycle row. But a lock inside a single statement
 * does not make a count correct under READ COMMITTED: the statement's snapshot is taken when the
 * statement BEGINS, so a contender that waits on the cycle lock and then proceeds still counts
 * offers as they stood before the winner committed, and the cap is breached anyway. Every
 * statement in a transaction takes a FRESH snapshot, so taking the lock in element 1 and counting
 * in a LATER element is what actually closes it — the later element's snapshot is taken after the
 * wait ended. That is the one shape available on this driver, and it is why the plan's "one
 * data-modifying CTE per transition" holds for decline and accept (no cross-row cap) but not here.
 *
 * Lock order is cycle, then application — fixed, and mandatory in that direction. An application
 * lock alone cannot serialize a cycle-wide cap across DIFFERENT applications.
 *
 * Element 2 expires lapsed pending offers before anything counts them: the cap counts every
 * `status = 'pending'` row as live, and creation never refreshed them, so stale rows silently ate
 * the cycle's capacity. It is `refreshExpiredOffersDb`'s statement, which the read paths already
 * run.
 *
 * Element 3 is the decisive one: it inserts, marks the application offered, and writes audit in a
 * single statement, each gated on the insert's own `RETURNING`. Zero rows means refused, and the
 * REASON is then classified by a follow-up read — the caller's error vocabulary is unchanged
 * (Locked decision 2).
 */
export async function createOfferDb(input: {
  applicationId: string;
  staffHumanId: string;
  expiresAtIso: string;
  payload: Record<string, unknown>;
}): Promise<StoredAdmissionsOffer> {
  // An unlocked read, used only to learn which cycle to lock. Every condition it might observe is
  // re-derived inside the decisive statement, so a stale answer here cannot admit anything.
  const app = await getApplicationByIdDb(input.applicationId);
  if (!app || app.state !== "shortlisted") throw new Error("application_not_shortlisted");

  const id = genId("admoff");
  try {
    const [, , , created] = await sql!.transaction((txn) => [
      // Every admissions transition takes the AGENT row first. Both agent-deletion paths lock
      // `agents` and then cascade into `admissions_applications` and `admissions_offers`, so any
      // writer that reaches an agent row THROUGH an application or an offer runs the opposite way
      // and can deadlock with a deletion (40P01). This offer insert reaches one implicitly: its
      // `agent_id` FK takes `FOR KEY SHARE`. Taking that lock up front puts both writers in one
      // order — agents, then cycles, then applications, then offers.
      txn`SELECT id FROM agents WHERE id = ${app.agentId} FOR KEY SHARE`,
      txn`
        /* d6:offer-cycle-lock */
        SELECT id FROM admissions_cycles WHERE id = ${app.cycleId} FOR UPDATE
      `,
      txn`
        WITH sweep_agents AS (
          -- The sweep touches OTHER agents' rows, so it needs the same agents-first order, and a
          -- deterministic one (ORDER BY) so two concurrent sweeps cannot take them in opposite
          -- orders either.
          SELECT a.id FROM agents a
          WHERE a.id IN (
            SELECT o.agent_id FROM admissions_offers o
            WHERE o.cycle_id = ${app.cycleId} AND o.status = 'pending' AND o.expires_at < NOW()
          )
          ORDER BY a.id
          FOR KEY SHARE
        ), expired AS (
          UPDATE admissions_offers o SET status = 'expired'
          FROM sweep_agents sa
          WHERE o.agent_id = sa.id AND o.cycle_id = ${app.cycleId}
            AND o.status = 'pending' AND o.expires_at < NOW()
          RETURNING o.application_id
        )
        UPDATE admissions_applications a
        SET state = 'in_pool', updated_at = NOW()
        FROM expired e
        WHERE a.id = e.application_id AND a.state = 'offered'
          -- Only release an application that has NO OTHER live offer. The corruption this whole
          -- chunk repairs can leave two pending offers on one application; expiring the lapsed one
          -- and releasing the application anyway would leave it in_pool while a live offer still
          -- stands, which is a worse state than the one being cleaned up.
          AND NOT EXISTS (
            SELECT 1 FROM admissions_offers o2
            WHERE o2.application_id = a.id AND o2.status = 'pending' AND o2.expires_at >= NOW()
          )
      `,
    txn`
      WITH locked_app AS (
        SELECT a.id, a.agent_id, a.cycle_id
        FROM admissions_applications a
        WHERE a.id = ${app.id} AND a.state = 'shortlisted' AND a.cycle_id = ${app.cycleId}
        FOR UPDATE
      ), open_cycle AS (
        SELECT c.id, c.max_offers,
          (SELECT count(*) FROM admissions_offers o WHERE o.cycle_id = c.id AND o.status = 'pending') AS pending
        FROM admissions_cycles c
        WHERE c.id = ${app.cycleId} AND c.status = 'open'
      ), inserted AS (
        INSERT INTO admissions_offers (
          id, agent_id, cycle_id, application_id, status, offer_version, payload_json,
          expires_at, created_by_staff_human_id
        )
        SELECT ${id}, la.agent_id, la.cycle_id, la.id, 'pending', 1,
               ${JSON.stringify(input.payload)}::jsonb, ${input.expiresAtIso}, ${input.staffHumanId}
        FROM locked_app la
        JOIN open_cycle oc ON oc.id = la.cycle_id
        WHERE (oc.max_offers IS NULL OR oc.pending < oc.max_offers)
          AND NOT EXISTS (
            SELECT 1 FROM admissions_offers o2 WHERE o2.agent_id = la.agent_id AND o2.status = 'pending'
          )
        RETURNING id, agent_id, application_id
      ), offered AS (
        UPDATE admissions_applications SET state = 'offered', updated_at = NOW()
        WHERE id IN (SELECT application_id FROM inserted)
        RETURNING id
      )
      INSERT INTO admissions_audit (offer_id, application_id, agent_id, actor_type, actor_id, action, detail)
      SELECT i.id, i.application_id, i.agent_id, 'staff', ${input.staffHumanId}, 'offer_created',
             ${JSON.stringify({ expires_at: input.expiresAtIso })}::jsonb
      FROM inserted i
      RETURNING offer_id
    `,
    ]);

    if ((created as unknown[]).length === 0) throw new Error(await classifyOfferRefusalDb(app.id, app.agentId, app.cycleId));
  } catch (error) {
    // The partial unique index firing is a REFUSAL, not a crash. Two offers for one agent in two
    // DIFFERENT cycles lock different cycle rows, so both `NOT EXISTS` checks can pass and the
    // index picks the winner — without this the loser leaves the store as a raw 23505 and the
    // staff route answers 500 instead of the error the caller's vocabulary already has.
    if (isAdmissionsUniqueViolation(error)) throw new Error("agent_has_pending_offer");
    throw error;
  }

  const offer = await getOfferByIdDb(id);
  if (!offer) throw new Error("offer_create_failed");
  return offer;
}

/** Postgres `unique_violation`. Structural check, never a message match. */
function isAdmissionsUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "23505";
}

/**
 * Why the decisive statement admitted nothing, as the error the caller already knows.
 *
 * A follow-up read rather than a branchier statement: the refusal has already happened and nothing
 * is being decided here, so a shifting answer can only mislabel a refusal, never cause one. The
 * order matches the pre-D6 sequence of checks so the same situation reports the same error.
 */
async function classifyOfferRefusalDb(applicationId: string, agentId: string, cycleId: string): Promise<string> {
  const app = await getApplicationByIdDb(applicationId);
  if (!app || app.state !== "shortlisted") return "application_not_shortlisted";

  const pending = await sql!`
    SELECT id FROM admissions_offers WHERE agent_id = ${agentId} AND status = 'pending' LIMIT 1
  `;
  if (pending.length > 0) return "agent_has_pending_offer";

  const cycle = await getCycleDb(cycleId);
  if (!cycle || cycle.status !== "open") return "cycle_not_open";
  if (cycle.maxOffers != null && (await countPendingOffersInCycleDb(cycleId)) >= cycle.maxOffers) {
    return "cycle_offer_cap_reached";
  }
  return "offer_create_failed";
}

export async function getOfferByIdDb(offerId: string): Promise<StoredAdmissionsOffer | null> {
  const rows = await sql!`SELECT * FROM admissions_offers WHERE id = ${offerId} LIMIT 1`;
  const r = rows[0] as Record<string, unknown> | undefined;
  return r ? rowOffer(r) : null;
}

type AdmissionsTxn = NeonQueryFunctionInTransaction<false, false>;

/**
 * Finalization, as ONE statement whose own transition is the idempotence gate (M11-1b D6).
 *
 * The pre-D6 shape was four separately-guarded statements, and the guard was "no
 * `admission_finalized` audit row exists yet". Two concurrent accepts could each read that guard
 * as true — sibling statements in a batch share no lock, and the audit row lands last — so both
 * could admit the agent and both could append. The `pending -> fully_accepted` flip is a much
 * stronger gate: only one transaction can perform it, and every other write here hangs off its
 * `RETURNING`. A second call finds the offer already `fully_accepted`, transitions nothing, and
 * therefore writes nothing.
 *
 * Lock order is `admissions_offers -> agents`. Nothing in the repo takes an `agents` lock and then
 * asks for an admissions row, so this cannot cycle; the `agents` write is a plain `UPDATE`
 * (`FOR NO KEY UPDATE`), which does not conflict with the `FOR KEY SHARE` an offer insert's FK
 * takes on the same row.
 */
function finalizeOfferStatement(txn: AdmissionsTxn, offerId: string) {
  return txn`
      WITH locked_agent AS (
        -- Agents first (see createOfferDb): this statement UPDATES the agent row, and agent
        -- deletion holds that row while cascading into offers. Reaching the agent through the
        -- offer would be the reverse order.
        SELECT a.id FROM admissions_offers o JOIN agents a ON a.id = o.agent_id
        WHERE o.id = ${offerId}
        FOR KEY SHARE OF a
      ), finalized AS (
        UPDATE admissions_offers o
        SET status = 'fully_accepted'
        FROM locked_agent la
        WHERE o.id = ${offerId}
          AND o.agent_id = la.id
          AND o.status = 'pending'
          AND o.expires_at > NOW()
          AND o.accepted_at_agent IS NOT NULL
          AND (
            o.accepted_at_human IS NOT NULL
            OR NOT EXISTS (SELECT 1 FROM user_agents ua WHERE ua.agent_id = o.agent_id)
          )
        RETURNING o.id, o.agent_id, o.application_id
      ), admitted AS (
        UPDATE agents SET is_admitted = TRUE
        WHERE id IN (SELECT agent_id FROM finalized)
        RETURNING id
      ), decided AS (
        UPDATE admissions_applications
        SET state = 'admitted', decided_at = NOW(), updated_at = NOW()
        WHERE id IN (SELECT application_id FROM finalized WHERE application_id IS NOT NULL)
        RETURNING id
      )
      INSERT INTO admissions_audit (offer_id, application_id, agent_id, actor_type, actor_id, action, detail)
      SELECT f.id, f.application_id, f.agent_id, 'system', null, 'admission_finalized', '{}'::jsonb
      FROM finalized f
    `;
}

/**
 * M11-1b D6 — acceptance, made idempotent by its own predicate.
 *
 * The pre-D6 shape ran as a batch whose audit element asked only whether `accepted_at_agent IS NOT
 * NULL` — which stays true on every retry, so each repeated call appended another audit row and
 * rewrote the timestamp. A later fixed element cannot tell whether THIS invocation won. So the
 * timestamp write carries `accepted_at_agent IS NULL` and its `RETURNING` drives the audit insert
 * in the same statement: the second call transitions nothing and writes nothing.
 *
 * Finalization is the second element, and it is one statement for the same reason (see
 * `finalizeOfferStatement`). It needs to observe this element's write, which a later statement in
 * the same transaction does — each takes a fresh snapshot.
 */
export async function acceptOfferAsAgentDb(offerId: string, agentId: string): Promise<"ok" | "invalid"> {
  const offer = await getOfferByIdDb(offerId);
  if (!offer || offer.agentId !== agentId || offer.status !== "pending") return "invalid";
  if (new Date(offer.expiresAt).getTime() < Date.now()) return "invalid";

  await sql!.transaction((txn) => [
    txn`SELECT id FROM agents WHERE id = ${agentId} FOR KEY SHARE`,
    txn`
      WITH accepted AS (
        UPDATE admissions_offers
        SET accepted_at_agent = NOW()
        WHERE id = ${offerId} AND agent_id = ${agentId} AND status = 'pending' AND expires_at > NOW()
          AND accepted_at_agent IS NULL
        RETURNING id, agent_id, application_id
      )
      INSERT INTO admissions_audit (offer_id, application_id, agent_id, actor_type, actor_id, action, detail)
      SELECT a.id, a.application_id, a.agent_id, 'agent', ${agentId}, 'accept_agent', '{}'::jsonb
      FROM accepted a
    `,
    finalizeOfferStatement(txn, offerId),
  ]);
  return classifyAcceptOutcomeDb(offerId, "agent");
}

/**
 * What an acceptance actually achieved, read back after the transaction.
 *
 * A decisive statement writing zero rows is NOT automatically `"ok"`: a decline could have won
 * after the pre-read, or the offer could have lapsed, in which case the caller must hear `invalid`
 * rather than a success that recorded nothing. But a REPEATED acceptance also writes zero rows and
 * is genuinely `"ok"` — the offer is accepted, this call simply added nothing. The stored
 * timestamp is what separates the two, so it is what this reads.
 */
async function classifyAcceptOutcomeDb(offerId: string, side: "agent" | "human"): Promise<"ok" | "invalid"> {
  const offer = await getOfferByIdDb(offerId);
  if (!offer) return "invalid";
  const stamped = side === "agent" ? offer.acceptedAtAgent : offer.acceptedAtHuman;
  if (!stamped) return "invalid";
  // `fully_accepted` is a success too — this side's acceptance is what got it there.
  return offer.status === "pending" || offer.status === "fully_accepted" ? "ok" : "invalid";
}

export async function acceptOfferAsHumanDb(offerId: string, humanUserId: string): Promise<"ok" | "invalid"> {
  const offer = await getOfferByIdDb(offerId);
  if (!offer || offer.status !== "pending") return "invalid";
  if (new Date(offer.expiresAt).getTime() < Date.now()) return "invalid";

  const links = await sql!`
    SELECT 1 FROM user_agents WHERE user_id = ${humanUserId} AND agent_id = ${offer.agentId} LIMIT 1
  `;
  if (links.length === 0) return "invalid";

  await sql!.transaction((txn) => [
    txn`SELECT id FROM agents WHERE id = ${offer.agentId} FOR KEY SHARE`,
    txn`
      WITH accepted AS (
        UPDATE admissions_offers o
        SET accepted_at_human = NOW(), accepted_human_user_id = ${humanUserId}
        WHERE o.id = ${offerId} AND o.status = 'pending' AND o.expires_at > NOW()
          AND o.accepted_at_human IS NULL
          -- The link is re-checked HERE, not only in the read above: a link revoked between the
          -- two would otherwise let a stale pre-check stand in for authorization.
          AND EXISTS (
            SELECT 1 FROM user_agents ua WHERE ua.user_id = ${humanUserId} AND ua.agent_id = o.agent_id
          )
        RETURNING o.id, o.agent_id, o.application_id
      )
      INSERT INTO admissions_audit (offer_id, application_id, agent_id, actor_type, actor_id, action, detail)
      SELECT a.id, a.application_id, a.agent_id, 'human', ${humanUserId}, 'accept_human', '{}'::jsonb
      FROM accepted a
    `,
    finalizeOfferStatement(txn, offerId),
  ]);
  return classifyAcceptOutcomeDb(offerId, "human");
}

/**
 * M11-1b D6 — a decline as ONE gated statement.
 *
 * Ownership and status WERE checked before D6 (correcting this chunk's own problem statement); the
 * defect was that the three writes that followed were unconditional and separately committed, so a
 * crash between them split offer, application and audit, and a concurrent decline could run the
 * whole sequence twice. The checks now live inside the decisive predicate and the other two writes
 * hang off its `RETURNING`, so zero rows is a clean no-op.
 *
 * @param actor `agent` authorizes by owning the offer; `human` by an active `user_agents` link.
 */
function declineOfferStatement(
  offerId: string,
  actor: { type: "agent"; agentId: string } | { type: "human"; humanUserId: string }
) {
  const actorId = actor.type === "agent" ? actor.agentId : actor.humanUserId;

  return sql!`
    WITH locked_agent AS (
      -- Agents first, for the reason spelled out on createOfferDb: agent deletion locks the agent
      -- and cascades INTO offers and applications, so a writer that goes the other way deadlocks
      -- with it. Consuming this CTE below is what forces the order — sibling CTE evaluation order
      -- is not guaranteed on its own.
      SELECT a.id FROM admissions_offers o JOIN agents a ON a.id = o.agent_id
      WHERE o.id = ${offerId}
      FOR KEY SHARE OF a
    ), declined AS (
      UPDATE admissions_offers o
      SET status = 'declined'
      FROM locked_agent la
      WHERE o.id = ${offerId} AND o.agent_id = la.id AND o.status = 'pending'
        -- Both ownership rules are parameterised into one predicate rather than composed from SQL
        -- fragments: this driver's tagged template has no fragment type, so an interpolated
        -- template would be bound as a VALUE and silently stop authorizing anything.
        AND (
          (${actor.type}::text = 'agent' AND o.agent_id = ${actorId})
          OR (${actor.type}::text = 'human' AND EXISTS (
                SELECT 1 FROM user_agents ua WHERE ua.user_id = ${actorId} AND ua.agent_id = o.agent_id
              ))
        )
      RETURNING o.id, o.agent_id, o.application_id
    ), released AS (
      UPDATE admissions_applications
      SET state = 'in_pool', updated_at = NOW()
      WHERE id IN (SELECT application_id FROM declined WHERE application_id IS NOT NULL)
      RETURNING id
    )
    INSERT INTO admissions_audit (offer_id, application_id, agent_id, actor_type, actor_id, action, detail)
    SELECT d.id, d.application_id, d.agent_id, ${actor.type}, ${actorId}, 'decline', '{}'::jsonb
    FROM declined d
    RETURNING offer_id
  `;
}

export async function declineOfferAsAgentDb(offerId: string, agentId: string): Promise<boolean> {
  const rows = await declineOfferStatement(offerId, { type: "agent", agentId });
  return rows.length > 0;
}

export async function declineOfferAsHumanDb(offerId: string, humanUserId: string): Promise<boolean> {
  const rows = await declineOfferStatement(offerId, { type: "human", humanUserId });
  return rows.length > 0;
}
