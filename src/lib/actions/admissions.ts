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

/**
 * The refusal `reason`s the admissions REST adapters map back to their EXACT legacy wire shapes
 * (title, hint, status) — M11-2 M9. The action classifies; each route renders. Admissions has no
 * tool surface, so these are consumed by the routes alone.
 */
export type AdmissionsRefusalReason =
  | "not_eligible"
  | "no_open_cycle"
  | "no_application"
  | "application_closed"
  | "cannot_accept"
  | "cannot_decline";

export async function updateNiche(input: { agent: StoredAgent; fields: { primaryDomain?: string | null; nonGoals?: string | null; evaluationPlan?: string | null } }): Promise<ActionResult<{ application: NonNullable<Awaited<ReturnType<typeof updateApplicationNiche>>> }>> {
  const eligibility = await getAdmissionsPoolEligibility(input.agent.id);
  if (!eligibility.eligible) return { ok: false, code: "forbidden", reason: "not_eligible", message: "Complete admissions criteria before editing an application." };
  const cycleId = await getDefaultOpenCycleId();
  if (!cycleId) return { ok: false, code: "bad_request", reason: "no_open_cycle", message: "No open admissions cycle is configured." };
  const app = await getApplicationByAgentCycle(input.agent.id, cycleId);
  if (!app) return { ok: false, code: "not_found", reason: "no_application", message: "No application" };
  if (["rejected", "admitted"].includes(app.state)) return { ok: false, code: "bad_request", reason: "application_closed", message: "This application is no longer editable." };
  const updated = await updateApplicationNiche(app.id, input.fields);
  return updated ? actionOk({ application: updated }) : { ok: false, code: "not_found", reason: "no_application", message: "No application" };
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
  return (await acceptOffer(input.offerId, input.agent.id, [event])) === "ok"
    ? actionOk({})
    : { ok: false, code: "bad_request", reason: "cannot_accept", message: "Cannot accept offer" };
}

export async function declineAgentOffer(input: { agent: StoredAgent; offerId: string }): Promise<ActionResult<Record<string, never>>> {
  const offer = await getOfferById(input.offerId);
  if (!offer || offer.agentId !== input.agent.id) return actionError("not_found", "Offer not found");
  const event: PreparedEvent<"admissions.offer_declined"> = {
    kind: "admissions.offer_declined", actorAgentId: input.agent.id,
    subjectType: "admissions_offer", subjectId: offer.id, secondarySubjectId: offer.applicationId, payload: {},
  };
  return (await declineOffer(input.offerId, input.agent.id, [event]))
    ? actionOk({})
    : { ok: false, code: "bad_request", reason: "cannot_decline", message: "Cannot decline offer" };
}
