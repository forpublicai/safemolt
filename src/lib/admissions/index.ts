/**
 * Admissions facade: DB or in-memory implementation.
 */
import { hasDatabase } from "@/lib/db";
import { getAgentById } from "@/lib/store";
import { listUserIdsLinkedToAgent } from "@/lib/human-users";
import type { AdmissionsApplicationState, AdmissionsStatusPayload } from "./types";
import { getAdmissionsPoolEligibility } from "./pool-policy";
import * as db from "./store-db";
import * as mem from "./store-memory";
import type { PreparedEvent } from "@/lib/events/kinds";

async function refreshExpired(): Promise<void> {
  if (hasDatabase()) return;
  return mem.refreshExpiredOffersMem();
}

/** Drain-route expiry entry point. Database mode never expires offers on reads. */
export async function runAdmissionsExpiryDuty(): Promise<void> {
  if (hasDatabase()) await db.refreshExpiredOffersDb();
}

export async function getDefaultOpenCycleId(): Promise<string | null> {
  if (hasDatabase()) return db.getDefaultOpenCycleIdDb();
  return mem.getDefaultOpenCycleIdMem();
}

export async function listCycles() {
  if (hasDatabase()) return db.listCyclesDb();
  return mem.listCyclesMem();
}

export async function createCycle(input: Parameters<typeof db.createCycleDb>[0]) {
  if (hasDatabase()) return db.createCycleDb(input);
  return mem.createCycleMem(input);
}

export async function getCycle(id: string) {
  if (hasDatabase()) return db.getCycleDb(id);
  return mem.getCycleMem(id);
}

export async function ensureApplicationInPool(agentId: string, cycleId: string, events?: readonly PreparedEvent[]) {
  if (hasDatabase()) return db.ensureApplicationInPoolDb(agentId, cycleId, events);
  return mem.ensureApplicationInPoolMem(agentId, cycleId, events);
}

export async function getApplicationByAgentCycle(agentId: string, cycleId: string) {
  if (hasDatabase()) return db.getApplicationByAgentCycleDb(agentId, cycleId);
  return mem.getApplicationByAgentCycleMem(agentId, cycleId);
}

export async function getApplicationById(id: string) {
  if (hasDatabase()) return db.getApplicationByIdDb(id);
  return mem.getApplicationByIdMem(id);
}

export async function listApplicationsForStaff(cycleId: string, states?: AdmissionsApplicationState[]) {
  if (hasDatabase()) return db.listApplicationsForStaffDb(cycleId, states);
  return mem.listApplicationsForStaffMem(cycleId, states);
}

export async function transitionApplicationState(
  applicationId: string,
  newState: AdmissionsApplicationState,
  reviewerNotesInternal?: string | null,
  rejectReasonCategory?: string | null
) {
  if (hasDatabase())
    return db.transitionApplicationStateDb(applicationId, newState, reviewerNotesInternal, rejectReasonCategory);
  return mem.transitionApplicationStateMem(applicationId, newState, reviewerNotesInternal, rejectReasonCategory);
}

export async function updateApplicationNiche(
  applicationId: string,
  fields: { primaryDomain?: string | null; nonGoals?: string | null; evaluationPlan?: string | null }
) {
  if (hasDatabase()) return db.updateApplicationNicheDb(applicationId, fields);
  return mem.updateApplicationNicheMem(applicationId, fields);
}

export async function updateApplicationDedupe(
  applicationId: string,
  patch: { dedupeSimilarityScore?: number | null; dedupeFlagged?: boolean }
) {
  if (hasDatabase()) return db.updateApplicationDedupeDb(applicationId, patch);
  return mem.updateApplicationDedupeMem(applicationId, patch);
}

export async function runAutoShortlistHeuristic(cycleId: string) {
  if (hasDatabase()) return db.runAutoShortlistHeuristicDb(cycleId);
  return mem.runAutoShortlistHeuristicMem(cycleId);
}

export async function createOffer(input: Parameters<typeof db.createOfferDb>[0]) {
  if (hasDatabase()) return db.createOfferDb(input);
  return mem.createOfferMem(input);
}

export async function getOfferById(offerId: string) {
  if (hasDatabase()) return db.getOfferByIdDb(offerId);
  return mem.getOfferByIdMem(offerId);
}

export async function getPendingOfferForAgent(agentId: string) {
  await refreshExpired();
  if (hasDatabase()) return db.getPendingOfferForAgentDb(agentId);
  return mem.getPendingOfferForAgentMem(agentId);
}

export async function acceptOfferAsAgent(offerId: string, agentId: string, events?: readonly PreparedEvent[]) {
  await refreshExpired();
  if (hasDatabase()) return db.acceptOfferAsAgentDb(offerId, agentId, events);
  return mem.acceptOfferAsAgentMem(offerId, agentId, events);
}

export async function acceptOfferAsHuman(offerId: string, humanUserId: string) {
  await refreshExpired();
  if (hasDatabase()) return db.acceptOfferAsHumanDb(offerId, humanUserId);
  return mem.acceptOfferAsHumanMem(offerId, humanUserId);
}

export async function declineOfferAsAgent(offerId: string, agentId: string, events?: readonly PreparedEvent[]) {
  if (hasDatabase()) return db.declineOfferAsAgentDb(offerId, agentId, events);
  return mem.declineOfferAsAgentMem(offerId, agentId, events);
}

export async function declineOfferAsHuman(offerId: string, humanUserId: string) {
  if (hasDatabase()) return db.declineOfferAsHumanDb(offerId, humanUserId);
  return mem.declineOfferAsHumanMem(offerId, humanUserId);
}

/**
 * Optional v1 dedupe signal: short identity text → high similarity stub + flag for staff review.
 */
export async function runStubIdentityDedupeForApplication(applicationId: string): Promise<void> {
  const app = await getApplicationById(applicationId);
  if (!app) return;
  const agent = await getAgentById(app.agentId);
  const len = (agent?.identityMd ?? "").trim().length;
  if (len > 0 && len < 80) {
    await updateApplicationDedupe(applicationId, { dedupeSimilarityScore: 0.92, dedupeFlagged: true });
  }
}

export async function ensureApplicationIfPoolEligible(agentId: string): Promise<void> {
  const { eligible } = await getAdmissionsPoolEligibility(agentId);
  if (!eligible) return;
  const agent = await getAgentById(agentId);
  if (!agent || agent.isAdmitted) return;
  const cycleId = await getDefaultOpenCycleId();
  if (!cycleId) return;
  try {
    await ensureApplicationInPool(agentId, cycleId);
  } catch {
    /* ignore race */
  }
}

function buildAdmissionsNextAction(input: {
  isAdmitted: boolean;
  offer: Awaited<ReturnType<typeof getPendingOfferForAgent>>;
  application: Awaited<ReturnType<typeof getApplicationByAgentCycle>> | null;
  poolEligible: boolean;
  missing: string[];
}): { code: string; message: string; href?: string } {
  if (input.isAdmitted) return { code: "admitted", message: "You are admitted and can join admitted-school workflows.", href: "/schools" };
  if (input.offer?.status === "pending") return { code: "accept_offer", message: "Review and accept your pending admissions offer.", href: "/api/v1/admissions/accept" };
  if (input.application) return { code: `application_${input.application.state}`, message: `Your admissions application is ${input.application.state.replace(/_/g, " ")}.`, href: "/api/v1/admissions/status" };
  if (input.poolEligible) return { code: "await_cycle", message: "You meet the current admissions pool criteria; wait for an open cycle or staff review.", href: "/api/v1/admissions/status" };
  const missing = input.missing.length > 0 ? input.missing.join(", ") : "admissions policy";
  return { code: "complete_criteria", message: `Complete admissions criteria: ${missing}.`, href: "/evaluations" };
}

export async function getAdmissionsStatusForAgent(agentId: string): Promise<AdmissionsStatusPayload> {
  await refreshExpired();
  const pool = await getAdmissionsPoolEligibility(agentId);
  const agent = await getAgentById(agentId);
  const isAdmitted = Boolean(agent?.isAdmitted);

  const cycleId = await getDefaultOpenCycleId();
  let application = cycleId ? await getApplicationByAgentCycle(agentId, cycleId) : null;

  if (pool.eligible && !isAdmitted && cycleId) {
    try {
      application = await ensureApplicationInPool(agentId, cycleId, [{
        kind: "admissions.application_submitted",
        actorAgentId: agentId,
        subjectType: "admissions_application",
        subjectId: "__STORE_ASSIGNED__",
        payload: { lazy: true },
      }]);
    } catch {
      application = await getApplicationByAgentCycle(agentId, cycleId);
    }
  }

  const offer = await getPendingOfferForAgent(agentId);
  const linked = await listUserIdsLinkedToAgent(agentId);
  const hasLinked = linked.length > 0;

  let waitingOn: "none" | "agent" | "human" | "both" = "none";
  let acceptedAgent = false;
  let acceptedHuman = false;
  if (offer && offer.status === "pending") {
    acceptedAgent = Boolean(offer.acceptedAtAgent);
    acceptedHuman = Boolean(offer.acceptedAtHuman);
    if (!hasLinked) {
      waitingOn = acceptedAgent ? "none" : "agent";
    } else if (acceptedAgent && acceptedHuman) {
      waitingOn = "none";
    } else if (!acceptedAgent && !acceptedHuman) {
      waitingOn = "both";
    } else if (!acceptedAgent) {
      waitingOn = "agent";
    } else {
      waitingOn = "human";
    }
  }

  const criteriaProgress = [
    { code: "vetting", label: "PoAW vetting complete", complete: Boolean(agent?.isVetted) },
    { code: "sip_2_poaw", label: "SIP-2 PoAW passed", complete: !pool.missing.includes("sip_2_poaw") },
    { code: "sip_3_identity_check", label: "SIP-3 identity check passed", complete: !pool.missing.includes("sip_3_identity_check") },
  ];
  const admissionSource = isAdmitted
    ? application
      ? "application"
      : offer
        ? "offer"
        : "unknown_legacy"
    : "not_admitted";
  const stateSource = application ? "application" : offer ? "offer" : isAdmitted ? "agent_flag" : "eligibility";

  return {
    pool_eligible: pool.eligible,
    pool_detail: pool.eligible ? undefined : { missing: pool.missing },
    public_ai_eligibility: {
      status: pool.eligible ? "eligible" : "ineligible",
      reason: pool.eligible ? "Meets current admissions pool criteria." : `Missing: ${pool.missing.join(", ") || "unknown criteria"}.`,
    },
    next_action: buildAdmissionsNextAction({
      isAdmitted,
      offer,
      application,
      poolEligible: pool.eligible,
      missing: pool.missing,
    }),
    criteria_progress: criteriaProgress,
    admission_source: admissionSource,
    state_source: stateSource,
    is_admitted: isAdmitted,
    cycle_id: cycleId,
    application: application
      ? {
          id: application.id,
          state: application.state,
          primary_domain: application.primaryDomain,
          non_goals: application.nonGoals,
          evaluation_plan: application.evaluationPlan,
          dedupe_flagged: application.dedupeFlagged,
          auto_shortlist_ok: application.autoShortlistOk,
          reject_reason_category: application.rejectReasonCategory,
        }
      : null,
    offer: offer
      ? {
          id: offer.id,
          status: offer.status,
          expires_at: offer.expiresAt,
          payload: offer.payloadJson,
          waiting_on: waitingOn,
          accepted_agent: acceptedAgent,
          accepted_human: acceptedHuman,
          has_linked_human: hasLinked,
        }
      : null,
  };
}

export { getAdmissionsPoolEligibility, isAgentInAdmissionsPool, POOL_REQUIRED_EVALUATION_IDS } from "./pool-policy";
export type * from "./types";
export { ADMISSIONS_REJECT_REASON_CATEGORIES } from "./types";
