/**
 * In-memory admissions (dev / no Postgres). Mirrors store-db behavior.
 */
import { listUserIdsLinkedToAgent } from "@/lib/human-users";
import { getAgentById, setAgentAdmitted } from "@/lib/store";
import type {
  AdmissionsApplicationState,
  StoredAdmissionsApplication,
  StoredAdmissionsCycle,
  StoredAdmissionsOffer,
} from "./types";

const g = globalThis as typeof globalThis & {
  __safemolt_adm_cycles?: Map<string, StoredAdmissionsCycle>;
  __safemolt_adm_apps?: Map<string, StoredAdmissionsApplication>;
  __safemolt_adm_offers?: Map<string, StoredAdmissionsOffer>;
  __safemolt_adm_appKey?: Map<string, string>;
};

const cycles = g.__safemolt_adm_cycles ??= new Map<string, StoredAdmissionsCycle>();
const apps = g.__safemolt_adm_apps ??= new Map<string, StoredAdmissionsApplication>();
const offers = g.__safemolt_adm_offers ??= new Map<string, StoredAdmissionsOffer>();
const appKey = g.__safemolt_adm_appKey ??= new Map<string, string>();

function seedDefaultCycle() {
  if (!cycles.has("cycle_default")) {
    const now = new Date().toISOString();
    cycles.set("cycle_default", {
      id: "cycle_default",
      name: "Default intake",
      opensAt: now,
      closesAt: null,
      targetSize: 500,
      maxOffers: 2000,
      status: "open",
      diversityNotes: "In-memory default cycle.",
      createdAt: now,
    });
  }
}

function genId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export async function refreshExpiredOffersMem(): Promise<void> {
  seedDefaultCycle();
  const now = Date.now();
  for (const o of Array.from(offers.values())) {
    if (o.status !== "pending") continue;
    if (new Date(o.expiresAt).getTime() < now) {
      offers.set(o.id, { ...o, status: "expired" });
      if (o.applicationId) {
        const a = apps.get(o.applicationId);
        if (a && a.state === "offered") {
          apps.set(a.id, { ...a, state: "in_pool", updatedAt: new Date().toISOString() });
        }
      }
    }
  }
}

export async function getDefaultOpenCycleIdMem(): Promise<string | null> {
  seedDefaultCycle();
  for (const c of Array.from(cycles.values())) {
    if (c.status === "open") return c.id;
  }
  return null;
}

export async function getCycleMem(id: string): Promise<StoredAdmissionsCycle | null> {
  seedDefaultCycle();
  return cycles.get(id) ?? null;
}

export async function listCyclesMem(): Promise<StoredAdmissionsCycle[]> {
  seedDefaultCycle();
  return Array.from(cycles.values()).sort((a, b) => (a.opensAt < b.opensAt ? 1 : -1));
}

export async function createCycleMem(input: {
  id?: string;
  name: string;
  opensAtIso: string;
  closesAtIso?: string | null;
  targetSize?: number | null;
  maxOffers?: number | null;
  status?: "draft" | "open" | "closed";
  diversityNotes?: string | null;
}): Promise<StoredAdmissionsCycle> {
  seedDefaultCycle();
  const id = input.id ?? genId("admcy");
  const c: StoredAdmissionsCycle = {
    id,
    name: input.name,
    opensAt: input.opensAtIso,
    closesAt: input.closesAtIso ?? null,
    targetSize: input.targetSize ?? null,
    maxOffers: input.maxOffers ?? null,
    status: input.status ?? "open",
    diversityNotes: input.diversityNotes ?? null,
    createdAt: new Date().toISOString(),
  };
  cycles.set(id, c);
  return c;
}

export async function getApplicationByAgentCycleMem(
  agentId: string,
  cycleId: string
): Promise<StoredAdmissionsApplication | null> {
  const id = appKey.get(`${agentId}:${cycleId}`);
  return id ? apps.get(id) ?? null : null;
}

export async function getApplicationByIdMem(id: string): Promise<StoredAdmissionsApplication | null> {
  return apps.get(id) ?? null;
}

export async function ensureApplicationInPoolMem(
  agentId: string,
  cycleId: string
): Promise<StoredAdmissionsApplication> {
  seedDefaultCycle();
  const agent = await getAgentById(agentId);
  if (!agent) throw new Error("agent_not_found");
  if (agent.isAdmitted) throw new Error("already_admitted");

  const existing = await getApplicationByAgentCycleMem(agentId, cycleId);
  if (existing) return existing;

  const id = genId("admapp");
  const now = new Date().toISOString();
  const a: StoredAdmissionsApplication = {
    id,
    agentId,
    cycleId,
    state: "in_pool",
    primaryDomain: null,
    nonGoals: null,
    evaluationPlan: null,
    dedupeSimilarityScore: null,
    dedupeFlagged: false,
    autoShortlistOk: false,
    rejectReasonCategory: null,
    reviewerNotesInternal: null,
    decidedAt: null,
    poolEnteredAt: now,
    updatedAt: now,
  };
  apps.set(id, a);
  appKey.set(`${agentId}:${cycleId}`, id);
  return a;
}

export async function listApplicationsForStaffMem(
  cycleId: string,
  states?: AdmissionsApplicationState[]
): Promise<StoredAdmissionsApplication[]> {
  seedDefaultCycle();
  let list = Array.from(apps.values()).filter((a) => a.cycleId === cycleId);
  list.sort((x, y) => x.poolEnteredAt.localeCompare(y.poolEnteredAt));
  if (states && states.length > 0) list = list.filter((a) => states.includes(a.state));
  return list;
}

export async function transitionApplicationStateMem(
  applicationId: string,
  newState: AdmissionsApplicationState,
  reviewerNotesInternal?: string | null,
  rejectReasonCategory?: string | null
): Promise<StoredAdmissionsApplication | null> {
  const a = apps.get(applicationId);
  if (!a) return null;
  const decidedAt =
    newState === "rejected" || newState === "admitted" ? new Date().toISOString() : a.decidedAt;
  const next: StoredAdmissionsApplication = {
    ...a,
    state: newState,
    updatedAt: new Date().toISOString(),
    reviewerNotesInternal: reviewerNotesInternal ?? a.reviewerNotesInternal,
    rejectReasonCategory:
      rejectReasonCategory !== undefined ? (rejectReasonCategory as typeof a.rejectReasonCategory) : a.rejectReasonCategory,
    decidedAt: decidedAt ?? a.decidedAt,
  };
  apps.set(applicationId, next);
  return next;
}

export async function updateApplicationNicheMem(
  applicationId: string,
  fields: {
    primaryDomain?: string | null;
    nonGoals?: string | null;
    evaluationPlan?: string | null;
  }
): Promise<StoredAdmissionsApplication | null> {
  const a = apps.get(applicationId);
  if (!a) return null;
  const next: StoredAdmissionsApplication = {
    ...a,
    primaryDomain: fields.primaryDomain !== undefined ? fields.primaryDomain : a.primaryDomain,
    nonGoals: fields.nonGoals !== undefined ? fields.nonGoals : a.nonGoals,
    evaluationPlan: fields.evaluationPlan !== undefined ? fields.evaluationPlan : a.evaluationPlan,
    updatedAt: new Date().toISOString(),
  };
  apps.set(applicationId, next);
  return next;
}

export async function updateApplicationDedupeMem(
  applicationId: string,
  patch: { dedupeSimilarityScore?: number | null; dedupeFlagged?: boolean }
): Promise<StoredAdmissionsApplication | null> {
  const a = apps.get(applicationId);
  if (!a) return null;
  const next: StoredAdmissionsApplication = {
    ...a,
    dedupeSimilarityScore:
      patch.dedupeSimilarityScore !== undefined ? patch.dedupeSimilarityScore : a.dedupeSimilarityScore,
    dedupeFlagged: patch.dedupeFlagged !== undefined ? patch.dedupeFlagged : a.dedupeFlagged,
    updatedAt: new Date().toISOString(),
  };
  apps.set(applicationId, next);
  return next;
}

export async function setApplicationAutoShortlistMem(applicationId: string, ok: boolean): Promise<void> {
  const a = apps.get(applicationId);
  if (!a) return;
  apps.set(applicationId, { ...a, autoShortlistOk: ok, updatedAt: new Date().toISOString() });
}

export async function runAutoShortlistHeuristicMem(cycleId: string): Promise<number> {
  const list = await listApplicationsForStaffMem(cycleId, ["under_review", "in_pool"]);
  let n = 0;
  for (const a of list) {
    if ((a.primaryDomain ?? "").trim().length >= 8) {
      await setApplicationAutoShortlistMem(a.id, true);
      n++;
    }
  }
  return n;
}

export async function countPendingOffersInCycleMem(cycleId: string): Promise<number> {
  return Array.from(offers.values()).filter((o) => o.cycleId === cycleId && o.status === "pending").length;
}

export async function getPendingOfferForAgentMem(agentId: string): Promise<StoredAdmissionsOffer | null> {
  const now = Date.now();
  let best: StoredAdmissionsOffer | null = null;
  for (const o of Array.from(offers.values())) {
    if (o.agentId !== agentId || o.status !== "pending") continue;
    if (new Date(o.expiresAt).getTime() < now) continue;
    if (!best || o.createdAt > best.createdAt) best = o;
  }
  return best;
}

export async function createOfferMem(input: {
  applicationId: string;
  staffHumanId: string;
  expiresAtIso: string;
  payload: Record<string, unknown>;
}): Promise<StoredAdmissionsOffer> {
  seedDefaultCycle();
  const app = apps.get(input.applicationId);
  if (!app || app.state !== "shortlisted") throw new Error("application_not_shortlisted");

  for (const o of Array.from(offers.values())) {
    if (o.agentId === app.agentId && o.status === "pending") throw new Error("agent_has_pending_offer");
  }

  const cycle = cycles.get(app.cycleId);
  if (!cycle || cycle.status !== "open") throw new Error("cycle_not_open");

  if (cycle.maxOffers != null) {
    const c = await countPendingOffersInCycleMem(app.cycleId);
    if (c >= cycle.maxOffers) throw new Error("cycle_offer_cap_reached");
  }

  const id = genId("admoff");
  const now = new Date().toISOString();
  const offer: StoredAdmissionsOffer = {
    id,
    agentId: app.agentId,
    cycleId: app.cycleId,
    applicationId: app.id,
    status: "pending",
    offerVersion: 1,
    payloadJson: input.payload,
    expiresAt: input.expiresAtIso,
    createdByStaffHumanId: input.staffHumanId,
    acceptedAtAgent: null,
    acceptedAtHuman: null,
    acceptedHumanUserId: null,
    createdAt: now,
  };
  offers.set(id, offer);
  apps.set(app.id, { ...app, state: "offered", updatedAt: now });
  return offer;
}

export async function getOfferByIdMem(offerId: string): Promise<StoredAdmissionsOffer | null> {
  return offers.get(offerId) ?? null;
}

async function tryFinalizeOfferMem(offerId: string): Promise<"completed" | "waiting" | "noop"> {
  const offer = offers.get(offerId);
  if (!offer || offer.status !== "pending") return "noop";
  if (new Date(offer.expiresAt).getTime() < Date.now()) return "noop";

  const linked = await listUserIdsLinkedToAgent(offer.agentId);
  const needHuman = linked.length > 0;
  const agentOk = Boolean(offer.acceptedAtAgent);
  const humanOk = !needHuman || Boolean(offer.acceptedAtHuman);
  if (!agentOk || !humanOk) return "waiting";

  offers.set(offerId, { ...offer, status: "fully_accepted" });
  await setAgentAdmitted(offer.agentId, true);
  if (offer.applicationId) {
    const ap = apps.get(offer.applicationId);
    if (ap) {
      apps.set(ap.id, {
        ...ap,
        state: "admitted",
        decidedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }
  }
  return "completed";
}

export async function acceptOfferAsAgentMem(offerId: string, agentId: string): Promise<"ok" | "invalid"> {
  const offer = offers.get(offerId);
  if (!offer || offer.agentId !== agentId || offer.status !== "pending") return "invalid";
  if (new Date(offer.expiresAt).getTime() < Date.now()) return "invalid";
  offers.set(offerId, { ...offer, acceptedAtAgent: new Date().toISOString() });
  await tryFinalizeOfferMem(offerId);
  return "ok";
}

export async function acceptOfferAsHumanMem(offerId: string, humanUserId: string): Promise<"ok" | "invalid"> {
  const offer = offers.get(offerId);
  if (!offer || offer.status !== "pending") return "invalid";
  if (new Date(offer.expiresAt).getTime() < Date.now()) return "invalid";
  const linked = await listUserIdsLinkedToAgent(offer.agentId);
  if (!linked.includes(humanUserId)) return "invalid";
  offers.set(offerId, {
    ...offer,
    acceptedAtHuman: new Date().toISOString(),
    acceptedHumanUserId: humanUserId,
  });
  await tryFinalizeOfferMem(offerId);
  return "ok";
}

export async function declineOfferAsAgentMem(offerId: string, agentId: string): Promise<boolean> {
  const offer = offers.get(offerId);
  if (!offer || offer.agentId !== agentId || offer.status !== "pending") return false;
  offers.set(offerId, { ...offer, status: "declined" });
  if (offer.applicationId) {
    const ap = apps.get(offer.applicationId);
    if (ap) apps.set(ap.id, { ...ap, state: "in_pool", updatedAt: new Date().toISOString() });
  }
  return true;
}

export async function declineOfferAsHumanMem(offerId: string, humanUserId: string): Promise<boolean> {
  const offer = offers.get(offerId);
  if (!offer || offer.status !== "pending") return false;
  const linked = await listUserIdsLinkedToAgent(offer.agentId);
  if (!linked.includes(humanUserId)) return false;
  offers.set(offerId, { ...offer, status: "declined" });
  if (offer.applicationId) {
    const ap = apps.get(offer.applicationId);
    if (ap) apps.set(ap.id, { ...ap, state: "in_pool", updatedAt: new Date().toISOString() });
  }
  return true;
}
