/**
 * In-memory admissions (dev / no Postgres). Mirrors store-db behavior.
 */
// The SYNCHRONOUS link helpers, not the async facade: every ownership decision here has to
// happen in the same non-yielding section as the write it authorizes (M11-1b D6).
import { agentHasLinkedUsersSync, ownsAgentSync } from "@/lib/human-users-memory";
import { getAgentById, setAgentAdmitted } from "@/lib/store";
import type {
  AdmissionsApplicationState,
  StoredAdmissionsApplication,
  StoredAdmissionsCycle,
  StoredAdmissionsOffer,
} from "./types";
import type { PreparedEvent } from "@/lib/events/kinds";
import { appendPreparedBatch, prepareEventBatch } from "@/lib/store/events/memory";

const g = globalThis as typeof globalThis & {
  __safemolt_adm_cycles?: Map<string, StoredAdmissionsCycle>;
  __safemolt_adm_apps?: Map<string, StoredAdmissionsApplication>;
  __safemolt_adm_offers?: Map<string, StoredAdmissionsOffer>;
  __safemolt_adm_appKey?: Map<string, string>;
  __safemolt_adm_audit?: AdmissionsAuditEntry[];
};

const cycles = g.__safemolt_adm_cycles ??= new Map<string, StoredAdmissionsCycle>();
const apps = g.__safemolt_adm_apps ??= new Map<string, StoredAdmissionsApplication>();
const offers = g.__safemolt_adm_offers ??= new Map<string, StoredAdmissionsOffer>();
const appKey = g.__safemolt_adm_appKey ??= new Map<string, string>();

/**
 * M11-1b D6 — the audit projection memory mode previously had no representation of at all.
 *
 * Without it "repeated acceptance writes exactly one audit row" was literally unwritable as a
 * memory-mode gate: there was nothing to count. It mirrors the columns the db statements write,
 * and nothing but tests reads it.
 */
export interface AdmissionsAuditEntry {
  offerId: string | null;
  applicationId: string | null;
  agentId: string | null;
  actorType: "agent" | "human" | "staff" | "system";
  actorId: string | null;
  action: string;
  detail: Record<string, unknown>;
  createdAt: string;
}

const audit = g.__safemolt_adm_audit ??= [];

function recordAudit(entry: Omit<AdmissionsAuditEntry, "createdAt">): void {
  audit.push({ ...entry, createdAt: new Date().toISOString() });
}

/** Test accessor. `action` narrows to one kind; omit it for the whole log. */
export function readAdmissionsAuditMem(filter?: { offerId?: string; action?: string }): AdmissionsAuditEntry[] {
  return audit.filter(
    (e) =>
      (filter?.offerId === undefined || e.offerId === filter.offerId) &&
      (filter?.action === undefined || e.action === filter.action)
  );
}

/** Test helper: memory state is module-global, so suites must be able to start clean. */
export function clearAdmissionsAuditMem(): void {
  audit.length = 0;
}

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
  cycleId: string,
  events?: readonly PreparedEvent[]
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
  const batch = prepareEventBatch((events ?? []).map((event) => ({ ...event, subjectId: id })));
  apps.set(id, a);
  appKey.set(`${agentId}:${cycleId}`, id);
  await appendPreparedBatch(batch).dispatched;
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

/**
 * Expire lapsed pending offers and release their applications — synchronously, so it can sit
 * inside a caller's non-yielding section. Mirrors `refreshExpiredOffersDb`'s statement.
 */
function expireLapsedOffersSync(nowMs: number, nowIso: string): void {
  for (const o of Array.from(offers.values())) {
    if (o.status !== "pending" || new Date(o.expiresAt).getTime() >= nowMs) continue;
    offers.set(o.id, { ...o, status: "expired" });
    const ap = o.applicationId ? apps.get(o.applicationId) : undefined;
    if (!ap || ap.state !== "offered") continue;
    // Only release an application with NO OTHER live offer. Pre-D6 data can carry two pending
    // offers on one application; releasing it anyway would leave it in_pool under a live offer.
    const stillOffered = Array.from(offers.values()).some(
      (other) => other.applicationId === ap.id && other.status === "pending" && new Date(other.expiresAt).getTime() >= nowMs
    );
    if (!stillOffered) apps.set(ap.id, { ...ap, state: "in_pool", updatedAt: nowIso });
  }
}

/**
 * M11-1b D6, memory mode — every check and every mutation in ONE synchronous section.
 *
 * The pre-D6 shape `await`ed the cap count before mutating, and "single-threaded" is not atomic
 * across an `await`: two concurrent promises both counted, both found room, and both inserted. The
 * db side serializes on the cycle row; here the equivalent is simply never yielding between the
 * decision and the write. Stale pending offers are expired first for the same reason as db mode —
 * the cap counts every pending row, so lapsed ones would eat the cycle's capacity.
 */
export async function createOfferMem(input: {
  applicationId: string;
  staffHumanId: string;
  expiresAtIso: string;
  payload: Record<string, unknown>;
}): Promise<StoredAdmissionsOffer> {
  seedDefaultCycle();
  const now = new Date().toISOString();
  const nowMs = Date.now();

  const app = apps.get(input.applicationId);
  if (!app || app.state !== "shortlisted") throw new Error("application_not_shortlisted");

  // --- one synchronous section: no `await` from here to the final `offers.set` ---
  expireLapsedOffersSync(nowMs, now);

  const livePending = Array.from(offers.values()).filter((o) => o.status === "pending");
  if (livePending.some((o) => o.agentId === app.agentId)) throw new Error("agent_has_pending_offer");

  const cycle = cycles.get(app.cycleId);
  if (!cycle || cycle.status !== "open") throw new Error("cycle_not_open");
  if (cycle.maxOffers != null && livePending.filter((o) => o.cycleId === app.cycleId).length >= cycle.maxOffers) {
    throw new Error("cycle_offer_cap_reached");
  }

  const id = genId("admoff");
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
  recordAudit({
    offerId: id,
    applicationId: app.id,
    agentId: app.agentId,
    actorType: "staff",
    actorId: input.staffHumanId,
    action: "offer_created",
    detail: { expires_at: input.expiresAtIso },
  });
  // --- end synchronous section ---
  return offer;
}

export async function getOfferByIdMem(offerId: string): Promise<StoredAdmissionsOffer | null> {
  return offers.get(offerId) ?? null;
}

/**
 * M11-1b D6, memory mode — finalization gated on its own transition, exactly as db mode is.
 *
 * `linked` is read BEFORE the section that decides and mutates, so the `pending -> fully_accepted`
 * flip and every write that depends on it happen without yielding. The flip is also the
 * idempotence gate: a second call finds the offer already `fully_accepted` and returns `noop`,
 * which is what keeps the audit row single. `setAgentAdmitted` is awaited afterwards precisely
 * because the flip has already excluded every other caller.
 */
async function tryFinalizeOfferMem(offerId: string): Promise<"completed" | "waiting" | "noop"> {
  // --- one synchronous section, and it STARTS at the link read. Reading the links across an
  // `await` and then deciding on the stale answer is the same check-then-act window the db side
  // closes with an EXISTS predicate: a link added in the gap would let this finalize agent-only.
  const offer = offers.get(offerId);
  if (!offer || offer.status !== "pending") return "noop";
  if (new Date(offer.expiresAt).getTime() < Date.now()) return "noop";
  const humanOk = !agentHasLinkedUsersSync(offer.agentId) || Boolean(offer.acceptedAtHuman);
  if (!offer.acceptedAtAgent || !humanOk) return "waiting";

  const now = new Date().toISOString();
  offers.set(offerId, { ...offer, status: "fully_accepted" });
  if (offer.applicationId) {
    const ap = apps.get(offer.applicationId);
    if (ap) apps.set(ap.id, { ...ap, state: "admitted", decidedAt: now, updatedAt: now });
  }
  recordAudit({
    offerId,
    applicationId: offer.applicationId,
    agentId: offer.agentId,
    actorType: "system",
    actorId: null,
    action: "admission_finalized",
    detail: {},
  });
  // --- end synchronous section: the flip above has already excluded every other caller ---
  await setAgentAdmitted(offer.agentId, true);
  return "completed";
}

export async function acceptOfferAsAgentMem(offerId: string, agentId: string, events?: readonly PreparedEvent[]): Promise<"ok" | "invalid"> {
  const offer = offers.get(offerId);
  if (!offer || offer.agentId !== agentId || offer.status !== "pending") return "invalid";
  if (new Date(offer.expiresAt).getTime() < Date.now()) return "invalid";
  // Idempotent, matching db mode: only the FIRST acceptance writes a timestamp and an audit row.
  // Repeating the call is still "ok" — the offer is accepted — it simply records nothing new.
  if (!offer.acceptedAtAgent) {
    const batch = prepareEventBatch(events);
    offers.set(offerId, { ...offer, acceptedAtAgent: new Date().toISOString() });
    recordAudit({
      offerId,
      applicationId: offer.applicationId,
      agentId,
      actorType: "agent",
      actorId: agentId,
      action: "accept_agent",
      detail: {},
    });
    await appendPreparedBatch(batch).dispatched;
  }
  await tryFinalizeOfferMem(offerId);
  return "ok";
}

export async function acceptOfferAsHumanMem(offerId: string, humanUserId: string): Promise<"ok" | "invalid"> {
  // --- one synchronous section, authorization INCLUDED. `ownsAgentSync` exists for exactly this:
  // reading the link list across an `await` and then mutating lets a former owner act after their
  // link was revoked in the gap.
  const offer = offers.get(offerId);
  if (!offer || offer.status !== "pending") return "invalid";
  if (!ownsAgentSync(humanUserId, offer.agentId)) return "invalid";
  if (new Date(offer.expiresAt).getTime() < Date.now()) return "invalid";
  if (!offer.acceptedAtHuman) {
    offers.set(offerId, {
      ...offer,
      acceptedAtHuman: new Date().toISOString(),
      acceptedHumanUserId: humanUserId,
    });
    recordAudit({
      offerId,
      applicationId: offer.applicationId,
      agentId: offer.agentId,
      actorType: "human",
      actorId: humanUserId,
      action: "accept_human",
      detail: {},
    });
  }
  // --- end synchronous section ---
  await tryFinalizeOfferMem(offerId);
  return "ok";
}

/** The decline decision and all three of its writes, without yielding — db mode's one statement. */
function declineOfferMem(
  offerId: string,
  actor: { type: "agent" | "human"; actorId: string }
): boolean {
  const offer = offers.get(offerId);
  if (!offer || offer.status !== "pending") return false;
  const authorized =
    actor.type === "agent" ? offer.agentId === actor.actorId : ownsAgentSync(actor.actorId, offer.agentId);
  if (!authorized) return false;

  offers.set(offerId, { ...offer, status: "declined" });
  if (offer.applicationId) {
    const ap = apps.get(offer.applicationId);
    if (ap) apps.set(ap.id, { ...ap, state: "in_pool", updatedAt: new Date().toISOString() });
  }
  recordAudit({
    offerId,
    applicationId: offer.applicationId,
    agentId: offer.agentId,
    actorType: actor.type,
    actorId: actor.actorId,
    action: "decline",
    detail: {},
  });
  return true;
}

export async function declineOfferAsAgentMem(offerId: string, agentId: string, events?: readonly PreparedEvent[]): Promise<boolean> {
  const batch = prepareEventBatch(events);
  const ok = declineOfferMem(offerId, { type: "agent", actorId: agentId });
  if (ok) await appendPreparedBatch(batch).dispatched;
  return ok;
}

export async function declineOfferAsHumanMem(offerId: string, humanUserId: string): Promise<boolean> {
  // No `await` at all: `declineOfferMem` derives ownership synchronously, so a link revoked
  // concurrently cannot be papered over by a stale snapshot taken before a yield.
  return declineOfferMem(offerId, { type: "human", actorId: humanUserId });
}
