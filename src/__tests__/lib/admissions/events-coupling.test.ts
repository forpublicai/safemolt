/**
 * @jest-environment node
 *
 * M11-2 u3f-core (admissions) — the Tier-1 COUPLING and the memory races.
 *
 * Every admissions kind is history-only (`none` in all three manifests), so there is no shadow
 * projection to check. What is provable here is the property every Tier-1 producer must hold and the
 * two memory hazards agents.md's Decision-4 discipline exists to close:
 *
 *  - **no write without its event, no event without its write.** A pool-ensure that finds the
 *    application already there, a repeat accept, a decline of a non-pending offer and an expiry
 *    sweep with nothing due each mutate nothing and emit nothing;
 *  - **the event carries the statement's subjects/payload** — the created application id, the
 *    offer + its application as subject + secondary subject, `{ lazy }` on the submit;
 *  - **memory acceptance finalizes in the same non-yielding section as its write (M6)**, so a
 *    concurrent decline cannot flip a no-human offer to `declined` after acceptance recorded its
 *    event;
 *  - **the pool-ensure re-checks (agentId, cycleId) after its last await (M7)**, so two concurrent
 *    ensures make one application and one event, as the PG unique index permits;
 *  - **memory expiry emits `admissions.offer_expired` (B2)** — the driver the db side runs on the
 *    drain route — and applies the "no OTHER live offer" release predicate.
 *
 * Jest runs with no database, so `@/lib/store` *is* the memory store and `eventLog` *is* the log.
 */
import {
  clearAdmissionsAuditMem,
  createCycleMem,
  createOfferMem,
  acceptOfferAsAgentMem,
  declineOfferAsAgentMem,
  ensureApplicationInPoolMem,
  getApplicationByIdMem,
  getOfferByIdMem,
  refreshExpiredOffersMem,
  transitionApplicationStateMem,
} from "@/lib/admissions/store-memory";
import { acceptAgentOffer, declineAgentOffer, ensurePoolApplication } from "@/lib/actions/admissions";
import { linkUserToAgent } from "@/lib/human-users-memory";
import { agents, eventLog } from "@/lib/store/_memory-state";
import type { PreparedEvent } from "@/lib/events/kinds";
import type { StoredAgent, StoredEvent } from "@/lib/store-types";

let seq = 0;
const nextId = (label: string) => `admev${label}${Date.now().toString(36)}${(seq += 1)}`;
const HOUR = 3_600_000;
const inHours = (h: number) => new Date(Date.now() + h * HOUR).toISOString();

function seedAgent(overrides: Partial<StoredAgent> = {}): StoredAgent {
  const id = overrides.id ?? nextId("ag");
  const agent: StoredAgent = {
    id,
    name: overrides.name ?? id,
    apiKey: `admevkey_${id}`,
    points: 0,
    votePoints: 0,
    evaluationPoints: 0,
    legacyUnattributedPoints: 0,
    followerCount: 0,
    isClaimed: false,
    createdAt: new Date().toISOString(),
    isVetted: true,
    isAdmitted: false,
    ...overrides,
  } as StoredAgent;
  agents.set(agent.id, agent);
  return agent;
}

async function openCycle(maxOffers: number | null = 2000): Promise<string> {
  const cycle = await createCycleMem({
    id: nextId("cycle"),
    name: "coupling cycle",
    opensAtIso: new Date().toISOString(),
    maxOffers,
    status: "open",
  });
  return cycle.id;
}

/** An offered agent: application shortlisted then offered, offer pending. */
async function offered(cycleId: string, expiresAtIso = inHours(48)): Promise<{ agent: string; app: string; offer: string }> {
  const agent = seedAgent().id;
  const app = await ensureApplicationInPoolMem(agent, cycleId);
  await transitionApplicationStateMem(app.id, "shortlisted");
  const offer = await createOfferMem({ applicationId: app.id, staffHumanId: "staff_1", expiresAtIso, payload: {} });
  return { agent, app: app.id, offer: offer.id };
}

function mark(): number {
  return eventLog.rows.length === 0 ? 0 : eventLog.rows[eventLog.rows.length - 1]!.id;
}
function since(m: number, kind?: string): StoredEvent[] {
  return eventLog.rows.filter((row) => row.id > m && (kind === undefined || row.kind === kind));
}

const submitEvent = (agentId: string, lazy: boolean): PreparedEvent<"admissions.application_submitted"> => ({
  kind: "admissions.application_submitted",
  actorAgentId: agentId,
  subjectType: "admissions_application",
  subjectId: "__STORE_ASSIGNED__",
  payload: { lazy },
});

beforeEach(() => {
  clearAdmissionsAuditMem();
});

describe("application-ensure — the event is gated on the create", () => {
  it("emits one admissions.application_submitted naming the created application", async () => {
    const cycle = await openCycle();
    const agent = seedAgent();
    const before = mark();

    const app = await ensureApplicationInPoolMem(agent.id, cycle, [submitEvent(agent.id, true)]);

    const emitted = since(before, "admissions.application_submitted");
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      kind: "admissions.application_submitted",
      actorAgentId: agent.id,
      subjectType: "admissions_application",
      subjectId: app.id,
      payload: { lazy: true },
    });
  });

  it("emits NOTHING when the application already exists", async () => {
    const cycle = await openCycle();
    const agent = seedAgent();
    await ensureApplicationInPoolMem(agent.id, cycle, [submitEvent(agent.id, true)]);

    const before = mark();
    const again = await ensureApplicationInPoolMem(agent.id, cycle, [submitEvent(agent.id, false)]);
    expect(again.state).toBe("in_pool");
    expect(since(before)).toEqual([]);
  });

  it("through the action, carries the lazy flag the action built", async () => {
    const cycle = await openCycle();
    const agent = seedAgent();
    const before = mark();

    await ensurePoolApplication({ agent, cycleId: cycle, lazy: false });

    const emitted = since(before, "admissions.application_submitted");
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.payload).toEqual({ lazy: false });
    expect(emitted[0]!.actorAgentId).toBe(agent.id);
  });
});

describe("accept — the event is gated on the acceptance write", () => {
  it("emits admissions.offer_accepted with the offer and its application", async () => {
    const cycle = await openCycle();
    const { agent, app, offer } = await offered(cycle);
    const before = mark();

    const result = await acceptAgentOffer({ agent: agents.get(agent)!, offerId: offer });
    expect(result.ok).toBe(true);

    const emitted = since(before, "admissions.offer_accepted");
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      kind: "admissions.offer_accepted",
      actorAgentId: agent,
      subjectType: "admissions_offer",
      subjectId: offer,
      secondarySubjectId: app,
      payload: {},
    });
  });

  it("emits NOTHING on a repeat accept (idempotent, still ok)", async () => {
    const cycle = await openCycle();
    const { agent, offer } = await offered(cycle);
    await linkUserToAgent(`human_of_${agent}`, agent); // a human is linked, so acceptance waits — offer stays pending
    const acting = agents.get(agent)!;

    expect((await acceptAgentOffer({ agent: acting, offerId: offer })).ok).toBe(true);
    const before = mark();
    // The offer is still pending (waiting on the human), so a repeat records nothing and emits nothing.
    expect((await acceptAgentOffer({ agent: acting, offerId: offer })).ok).toBe(true);
    expect(since(before)).toEqual([]);
    expect((await getOfferByIdMem(offer))!.status).toBe("pending");
  });
});

describe("decline — the event is gated on the decline write", () => {
  it("emits admissions.offer_declined and returns the application to the pool", async () => {
    const cycle = await openCycle();
    const { agent, app, offer } = await offered(cycle);
    const before = mark();

    const result = await declineAgentOffer({ agent: agents.get(agent)!, offerId: offer });
    expect(result.ok).toBe(true);

    const emitted = since(before, "admissions.offer_declined");
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ subjectId: offer, secondarySubjectId: app });
    expect((await getOfferByIdMem(offer))!.status).toBe("declined");
    expect((await getApplicationByIdMem(app))!.state).toBe("in_pool");
  });

  it("emits NOTHING when the offer is not pending", async () => {
    const cycle = await openCycle();
    const { agent, offer } = await offered(cycle);
    // First decline succeeds; the offer is no longer pending.
    await declineOfferAsAgentMem(offer, agent, [
      { kind: "admissions.offer_declined", actorAgentId: agent, subjectType: "admissions_offer", subjectId: offer, payload: {} },
    ]);

    const before = mark();
    const ok = await declineOfferAsAgentMem(offer, agent, [
      { kind: "admissions.offer_declined", actorAgentId: agent, subjectType: "admissions_offer", subjectId: offer, payload: {} },
    ]);
    expect(ok).toBe(false);
    expect(since(before)).toEqual([]);
  });
});

describe("expiry — memory driver emits admissions.offer_expired (B2)", () => {
  it("expires a past-due offer, releases its application, and emits one event; a re-call emits nothing", async () => {
    const cycle = await openCycle();
    const { app, offer } = await offered(cycle, inHours(-1)); // already lapsed
    const before = mark();

    await refreshExpiredOffersMem();

    const emitted = since(before, "admissions.offer_expired").filter((e) => e.subjectId === offer);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      kind: "admissions.offer_expired",
      actorAgentId: null,
      subjectType: "admissions_offer",
      subjectId: offer,
      secondarySubjectId: app,
      payload: {},
    });
    expect((await getOfferByIdMem(offer))!.status).toBe("expired");
    expect((await getApplicationByIdMem(app))!.state).toBe("in_pool");

    // Already expired — a second sweep finds nothing due for it and emits nothing.
    const before2 = mark();
    await refreshExpiredOffersMem();
    expect(since(before2, "admissions.offer_expired").filter((e) => e.subjectId === offer)).toEqual([]);
  });

  it("does not expire, release or emit for an offer that is still live", async () => {
    const cycle = await openCycle();
    const { app, offer } = await offered(cycle, inHours(48)); // future
    const before = mark();

    await refreshExpiredOffersMem();

    expect(since(before, "admissions.offer_expired").filter((e) => e.subjectId === offer)).toEqual([]);
    expect((await getOfferByIdMem(offer))!.status).toBe("pending");
    expect((await getApplicationByIdMem(app))!.state).toBe("offered");
  });
});

describe("memory races — Decision-4 discipline (M6, M7)", () => {
  it("M6: a concurrent decline cannot interleave between accept write and finalize", async () => {
    // No human linked, so the agent's acceptance alone must finalize the offer. Pre-fix, memory
    // yielded on event dispatch before finalizing, so the decline flipped the still-pending offer to
    // `declined` after acceptance had recorded its event. The fix runs the accept write and the
    // finalize flip in one non-yielding section.
    const cycle = await openCycle();
    const { agent, offer } = await offered(cycle);
    const before = mark();

    const acceptEvent: PreparedEvent<"admissions.offer_accepted"> = {
      kind: "admissions.offer_accepted", actorAgentId: agent, subjectType: "admissions_offer", subjectId: offer, payload: {},
    };
    const declineEvent: PreparedEvent<"admissions.offer_declined"> = {
      kind: "admissions.offer_declined", actorAgentId: agent, subjectType: "admissions_offer", subjectId: offer, payload: {},
    };

    const [acceptResult] = await Promise.all([
      acceptOfferAsAgentMem(offer, agent, [acceptEvent]),
      declineOfferAsAgentMem(offer, agent, [declineEvent]),
    ]);

    expect(acceptResult).toBe("ok");
    // The acceptance won atomically: the offer is fully_accepted, and the decline was a no-op.
    expect((await getOfferByIdMem(offer))!.status).toBe("fully_accepted");
    expect(since(before, "admissions.offer_accepted").filter((e) => e.subjectId === offer)).toHaveLength(1);
    expect(since(before, "admissions.offer_declined").filter((e) => e.subjectId === offer)).toEqual([]);
  });

  it("M7: two concurrent pool-ensures make ONE application and ONE event", async () => {
    const cycle = await openCycle();
    const agent = seedAgent();
    const before = mark();

    const [a, b] = await Promise.all([
      ensureApplicationInPoolMem(agent.id, cycle, [submitEvent(agent.id, true)]),
      ensureApplicationInPoolMem(agent.id, cycle, [submitEvent(agent.id, true)]),
    ]);

    expect(a.id).toBe(b.id); // both resolved to the same application
    expect(since(before, "admissions.application_submitted")).toHaveLength(1);
  });
});
