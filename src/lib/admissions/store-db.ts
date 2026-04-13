/**
 * Postgres implementation of admissions (cycles, applications, offers, audit).
 */
import { sql } from "@/lib/db";
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
  try {
    await sql!`BEGIN`;
    const returned = await sql!`
      UPDATE admissions_offers
      SET status = 'expired'
      WHERE status = 'pending' AND expires_at < NOW()
      RETURNING application_id
    `;
    for (const row of returned as { application_id: string | null }[]) {
      if (row.application_id) {
        await sql!`
          UPDATE admissions_applications
          SET state = 'in_pool', updated_at = NOW()
          WHERE id = ${row.application_id} AND state = 'offered'
        `;
      }
    }
    await sql!`COMMIT`;
  } catch (e) {
    await sql!`ROLLBACK`;
    throw e;
  }
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

export async function createOfferDb(input: {
  applicationId: string;
  staffHumanId: string;
  expiresAtIso: string;
  payload: Record<string, unknown>;
}): Promise<StoredAdmissionsOffer> {
  const app = await getApplicationByIdDb(input.applicationId);
  if (!app || app.state !== "shortlisted") throw new Error("application_not_shortlisted");

  const existingPending = await sql!`
    SELECT id FROM admissions_offers WHERE agent_id = ${app.agentId} AND status = 'pending' LIMIT 1
  `;
  if (existingPending.length > 0) throw new Error("agent_has_pending_offer");

  const cycle = await getCycleDb(app.cycleId);
  if (!cycle || cycle.status !== "open") throw new Error("cycle_not_open");

  if (cycle.maxOffers != null) {
    const c = await countPendingOffersInCycleDb(app.cycleId);
    if (c >= cycle.maxOffers) throw new Error("cycle_offer_cap_reached");
  }

  const id = genId("admoff");
  await sql!`
    INSERT INTO admissions_offers (
      id, agent_id, cycle_id, application_id, status, offer_version, payload_json, expires_at, created_by_staff_human_id
    )
    VALUES (
      ${id}, ${app.agentId}, ${app.cycleId}, ${app.id}, 'pending', 1,
      ${JSON.stringify(input.payload)}::jsonb, ${input.expiresAtIso}, ${input.staffHumanId}
    )
  `;
  await sql!`
    UPDATE admissions_applications SET state = 'offered', updated_at = NOW() WHERE id = ${app.id}
  `;

  await sql!`
    INSERT INTO admissions_audit (offer_id, application_id, agent_id, actor_type, actor_id, action, detail)
    VALUES (
      ${id}, ${app.id}, ${app.agentId}, 'staff', ${input.staffHumanId}, 'offer_created',
      ${JSON.stringify({ expires_at: input.expiresAtIso })}::jsonb
    )
  `;

  const offer = await getOfferByIdDb(id);
  if (!offer) throw new Error("offer_create_failed");
  return offer;
}

export async function getOfferByIdDb(offerId: string): Promise<StoredAdmissionsOffer | null> {
  const rows = await sql!`SELECT * FROM admissions_offers WHERE id = ${offerId} LIMIT 1`;
  const r = rows[0] as Record<string, unknown> | undefined;
  return r ? rowOffer(r) : null;
}

async function listLinkedUserCountInTx(agentId: string): Promise<number> {
  const rows = await sql!`SELECT COUNT(*)::int AS c FROM user_agents WHERE agent_id = ${agentId}`;
  return Number((rows[0] as { c: number }).c);
}

export async function tryFinalizeOfferDb(offerId: string): Promise<"completed" | "waiting" | "noop"> {
  try {
    await sql!`BEGIN`;

    const rows = await sql!`SELECT * FROM admissions_offers WHERE id = ${offerId} FOR UPDATE`;
    const r = rows[0] as Record<string, unknown> | undefined;
    if (!r) {
      await sql!`ROLLBACK`;
      return "noop";
    }
    const offer = rowOffer(r);
    if (offer.status !== "pending") {
      await sql!`ROLLBACK`;
      return "noop";
    }
    const exp = new Date(offer.expiresAt).getTime();
    if (Number.isFinite(exp) && exp < Date.now()) {
      await sql!`ROLLBACK`;
      return "noop";
    }

    const linked = await listLinkedUserCountInTx(offer.agentId);
    const needHuman = linked > 0;
    const agentOk = Boolean(offer.acceptedAtAgent);
    const humanOk = !needHuman || Boolean(offer.acceptedAtHuman);

    if (!agentOk || !humanOk) {
      await sql!`COMMIT`;
      return "waiting";
    }

    await sql!`UPDATE admissions_offers SET status = 'fully_accepted' WHERE id = ${offerId}`;
    await sql!`UPDATE agents SET is_admitted = TRUE WHERE id = ${offer.agentId}`;
    if (offer.applicationId) {
      await sql!`
        UPDATE admissions_applications
        SET state = 'admitted', decided_at = NOW(), updated_at = NOW()
        WHERE id = ${offer.applicationId}
      `;
    }
    await sql!`
      INSERT INTO admissions_audit (offer_id, application_id, agent_id, actor_type, actor_id, action, detail)
      VALUES (
        ${offerId}, ${offer.applicationId}, ${offer.agentId}, 'system', null, 'admission_finalized',
        '{}'::jsonb
      )
    `;

    await sql!`COMMIT`;
    return "completed";
  } catch (e) {
    await sql!`ROLLBACK`;
    throw e;
  }
}

export async function acceptOfferAsAgentDb(offerId: string, agentId: string): Promise<"ok" | "invalid"> {
  const offer = await getOfferByIdDb(offerId);
  if (!offer || offer.agentId !== agentId || offer.status !== "pending") return "invalid";
  if (new Date(offer.expiresAt).getTime() < Date.now()) return "invalid";

  await sql!`
    UPDATE admissions_offers
    SET accepted_at_agent = NOW()
    WHERE id = ${offerId} AND agent_id = ${agentId} AND status = 'pending'
  `;
  await tryFinalizeOfferDb(offerId);
  await sql!`
    INSERT INTO admissions_audit (offer_id, agent_id, actor_type, actor_id, action, detail)
    VALUES (${offerId}, ${agentId}, 'agent', ${agentId}, 'accept_agent', '{}'::jsonb)
  `;
  return "ok";
}

export async function acceptOfferAsHumanDb(offerId: string, humanUserId: string): Promise<"ok" | "invalid"> {
  const offer = await getOfferByIdDb(offerId);
  if (!offer || offer.status !== "pending") return "invalid";
  if (new Date(offer.expiresAt).getTime() < Date.now()) return "invalid";

  const links = await sql!`
    SELECT 1 FROM user_agents WHERE user_id = ${humanUserId} AND agent_id = ${offer.agentId} LIMIT 1
  `;
  if (links.length === 0) return "invalid";

  await sql!`
    UPDATE admissions_offers
    SET accepted_at_human = NOW(), accepted_human_user_id = ${humanUserId}
    WHERE id = ${offerId} AND status = 'pending'
  `;
  await tryFinalizeOfferDb(offerId);
  await sql!`
    INSERT INTO admissions_audit (offer_id, agent_id, actor_type, actor_id, action, detail)
    VALUES (${offerId}, ${offer.agentId}, 'human', ${humanUserId}, 'accept_human', '{}'::jsonb)
  `;
  return "ok";
}

export async function declineOfferAsAgentDb(offerId: string, agentId: string): Promise<boolean> {
  const offer = await getOfferByIdDb(offerId);
  if (!offer || offer.agentId !== agentId || offer.status !== "pending") return false;
  await sql!`UPDATE admissions_offers SET status = 'declined' WHERE id = ${offerId}`;
  if (offer.applicationId) {
    await sql!`
      UPDATE admissions_applications SET state = 'in_pool', updated_at = NOW() WHERE id = ${offer.applicationId}
    `;
  }
  await sql!`
    INSERT INTO admissions_audit (offer_id, agent_id, actor_type, actor_id, action, detail)
    VALUES (${offerId}, ${agentId}, 'agent', ${agentId}, 'decline', '{}'::jsonb)
  `;
  return true;
}

export async function declineOfferAsHumanDb(offerId: string, humanUserId: string): Promise<boolean> {
  const offer = await getOfferByIdDb(offerId);
  if (!offer || offer.status !== "pending") return false;
  const links = await sql!`
    SELECT 1 FROM user_agents WHERE user_id = ${humanUserId} AND agent_id = ${offer.agentId} LIMIT 1
  `;
  if (links.length === 0) return false;
  await sql!`UPDATE admissions_offers SET status = 'declined' WHERE id = ${offerId}`;
  if (offer.applicationId) {
    await sql!`
      UPDATE admissions_applications SET state = 'in_pool', updated_at = NOW() WHERE id = ${offer.applicationId}
    `;
  }
  await sql!`
    INSERT INTO admissions_audit (offer_id, agent_id, actor_type, actor_id, action, detail)
    VALUES (${offerId}, ${offer.agentId}, 'human', ${humanUserId}, 'decline', '{}'::jsonb)
  `;
  return true;
}
