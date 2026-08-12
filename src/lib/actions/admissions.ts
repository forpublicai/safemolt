import {
  ensureApplicationInPool,
  getApplicationByAgentCycle,
  getDefaultOpenCycleId,
  updateApplicationNiche,
  acceptOfferAsAgent as acceptOffer,
  declineOfferAsAgent as declineOffer,
  getOfferById,
} from "@/lib/admissions";
import { getAdmissionsPoolEligibility } from "@/lib/admissions/pool-policy";
import { STORE_ASSIGNED_PAYLOAD_ID, type PreparedEvent } from "@/lib/events/kinds";
import type { StoredAgent } from "@/lib/store-types";
import { actionError, actionOk, type ActionResult } from "./types";

export async function updateNiche(input: { agent: StoredAgent; fields: { primaryDomain?: string | null; nonGoals?: string | null; evaluationPlan?: string | null } }): Promise<ActionResult<{ application: NonNullable<Awaited<ReturnType<typeof updateApplicationNiche>>> }>> {
  const eligibility = await getAdmissionsPoolEligibility(input.agent.id);
  if (!eligibility.eligible) return actionError("forbidden", "Complete admissions criteria before editing an application.");
  const cycleId = await getDefaultOpenCycleId();
  if (!cycleId) return actionError("bad_request", "No open admissions cycle is configured.");
  const app = await getApplicationByAgentCycle(input.agent.id, cycleId);
  if (!app) return actionError("not_found", "No application");
  if (["rejected", "admitted"].includes(app.state)) return actionError("bad_request", "This application is no longer editable.");
  const updated = await updateApplicationNiche(app.id, input.fields);
  return updated ? actionOk({ application: updated }) : actionError("not_found", "No application");
}

export async function ensurePoolApplication(input: { agent: StoredAgent; cycleId: string; lazy: boolean }) {
  const event: PreparedEvent<"admissions.application_submitted"> = {
    kind: "admissions.application_submitted", actorAgentId: input.agent.id,
    subjectType: "admissions_application", subjectId: STORE_ASSIGNED_PAYLOAD_ID,
    payload: { lazy: input.lazy },
  };
  return ensureApplicationInPool(input.agent.id, input.cycleId, [event]);
}

export async function acceptAgentOffer(input: { agent: StoredAgent; offerId: string }): Promise<ActionResult<Record<string, never>>> {
  const offer = await getOfferById(input.offerId);
  if (!offer || offer.agentId !== input.agent.id) return actionError("not_found", "Offer not found");
  const event: PreparedEvent<"admissions.offer_accepted"> = {
    kind: "admissions.offer_accepted", actorAgentId: input.agent.id,
    subjectType: "admissions_offer", subjectId: offer.id, secondarySubjectId: offer.applicationId,
    payload: {},
  };
  return (await acceptOffer(input.offerId, input.agent.id, [event])) === "ok" ? actionOk({}) : actionError("bad_request", "Cannot accept offer");
}

export async function declineAgentOffer(input: { agent: StoredAgent; offerId: string }): Promise<ActionResult<Record<string, never>>> {
  const offer = await getOfferById(input.offerId);
  if (!offer || offer.agentId !== input.agent.id) return actionError("not_found", "Offer not found");
  const event: PreparedEvent<"admissions.offer_declined"> = {
    kind: "admissions.offer_declined", actorAgentId: input.agent.id,
    subjectType: "admissions_offer", subjectId: offer.id, secondarySubjectId: offer.applicationId, payload: {},
  };
  return (await declineOffer(input.offerId, input.agent.id, [event])) ? actionOk({}) : actionError("bad_request", "Cannot decline offer");
}
