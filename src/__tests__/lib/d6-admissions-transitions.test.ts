/**
 * @jest-environment node
 *
 * M11-1b D6, memory mode — the admissions state machine's transitions.
 *
 * The db-side races and the partial unique index run in
 * `src/__tests__/integration/d6-admissions-transitions.test.ts`. What is provable here is the
 * shape the plan calls out as memory mode's own hazard: `await` is not atomic, so a preflight and
 * its mutation that straddle one interleave, and "single-threaded" protects nothing. Memory
 * admissions also had no audit representation at all before D6, which made "exactly one audit row"
 * literally unwritable as a gate.
 *
 * Everything is seeded through the store's own public functions — a bespoke seeder could quietly
 * build states the real flow cannot reach.
 */
jest.mock("@/lib/store", () => ({
  getAgentById: jest.fn(async (id: string) => ({ id, name: id, isAdmitted: admitted.has(id) })),
  setAgentAdmitted: jest.fn(async (id: string) => {
    admitted.add(id);
  }),
}));

const admitted = new Set<string>();

import { linkUserToAgent } from "@/lib/human-users-memory";
import {
  acceptOfferAsAgentMem,
  acceptOfferAsHumanMem,
  clearAdmissionsAuditMem,
  createCycleMem,
  createOfferMem,
  declineOfferAsAgentMem,
  declineOfferAsHumanMem,
  ensureApplicationInPoolMem,
  getOfferByIdMem,
  readAdmissionsAuditMem,
  transitionApplicationStateMem,
} from "@/lib/admissions/store-memory";

const HOUR = 3_600_000;
const inHours = (h: number) => new Date(Date.now() + h * HOUR).toISOString();

let seq = 0;
const nextId = (prefix: string) => `d6_${prefix}_${Date.now().toString(36)}_${(seq += 1)}`;

async function openCycle(maxOffers: number | null): Promise<string> {
  const cycle = await createCycleMem({
    id: nextId("cycle"),
    name: "D6 cycle",
    opensAtIso: new Date().toISOString(),
    maxOffers,
    status: "open",
  });
  return cycle.id;
}

/** An agent with a shortlisted application in `cycleId`, ready to be offered. */
async function shortlisted(cycleId: string): Promise<{ agent: string; app: string }> {
  const agent = nextId("agent");
  const app = await ensureApplicationInPoolMem(agent, cycleId);
  await transitionApplicationStateMem(app.id, "shortlisted");
  return { agent, app: app.id };
}

const offerFor = (applicationId: string, expiresAtIso = inHours(48)) =>
  createOfferMem({ applicationId, staffHumanId: "staff_1", expiresAtIso, payload: {} });

/**
 * Link a human to an agent through the REAL memory link store, not a mock of the async facade.
 * D6 moved every ownership decision onto the synchronous helpers precisely so it happens inside
 * the same non-yielding section as the write; a mocked async facade would no longer be consulted,
 * and these gates would assert nothing.
 *
 * The user id is derived from the (already unique) agent id, so the module-global link map cannot
 * leak a link from one test into another.
 */
async function link(agentId: string): Promise<string> {
  const userId = `human_of_${agentId}`;
  await linkUserToAgent(userId, agentId);
  return userId;
}

beforeEach(() => {
  clearAdmissionsAuditMem();
  admitted.clear();
  jest.clearAllMocks();
});

describe("staff offer creation", () => {
  it("cannot exceed the cycle cap under interleaved concurrent calls", async () => {
    // The pre-D6 shape `await`ed the cap count before mutating. Two promises both counted 0, both
    // found room under a cap of 1, and both inserted — "single-threaded" is not atomic across an
    // await. Both applications live in ONE capped cycle, which is exactly what an application-level
    // lock could never serialize.
    const cycle = await openCycle(1);
    const a = await shortlisted(cycle);
    const b = await shortlisted(cycle);

    const settled = await Promise.allSettled([offerFor(a.app), offerFor(b.app)]);

    expect(settled.filter((s) => s.status === "fulfilled")).toHaveLength(1);
    const refused = settled.find((s) => s.status === "rejected") as PromiseRejectedResult;
    expect((refused.reason as Error).message).toBe("cycle_offer_cap_reached");
    expect(readAdmissionsAuditMem({ action: "offer_created" })).toHaveLength(1);
  });

  it("refuses a second pending offer for one agent, even in another cycle", async () => {
    // The rule the db backstops with a partial unique index on agent_id: ONE pending offer per
    // agent, full stop. A per-cycle rule would silently weaken it.
    const cycleA = await openCycle(null);
    const { agent, app } = await shortlisted(cycleA);
    await offerFor(app);

    const cycleB = await openCycle(null);
    const second = await ensureApplicationInPoolMem(agent, cycleB);
    await transitionApplicationStateMem(second.id, "shortlisted");

    await expect(offerFor(second.id)).rejects.toThrow("agent_has_pending_offer");
  });

  it("does not let expired pending rows consume the cap", async () => {
    // The cap counts every `pending` row as live, and creation never refreshed them — so a lapsed
    // offer silently ate the cycle's capacity until something else happened to expire it.
    const cycle = await openCycle(1);
    const first = await shortlisted(cycle);
    const lapsed = await offerFor(first.app, inHours(-1));

    const second = await shortlisted(cycle);
    const offer = await offerFor(second.app);

    expect(offer.status).toBe("pending");
    expect((await getOfferByIdMem(lapsed.id))!.status).toBe("expired");
  });

  it("refuses an application that is not shortlisted, and writes nothing", async () => {
    const cycle = await openCycle(null);
    const agent = nextId("agent");
    const app = await ensureApplicationInPoolMem(agent, cycle); // still `in_pool`

    await expect(offerFor(app.id)).rejects.toThrow("application_not_shortlisted");
    expect(readAdmissionsAuditMem()).toHaveLength(0);
  });

  it("writes an audit row for the offer it created", async () => {
    const cycle = await openCycle(null);
    const { agent, app } = await shortlisted(cycle);
    const offer = await offerFor(app);

    expect(readAdmissionsAuditMem({ offerId: offer.id, action: "offer_created" })).toEqual([
      expect.objectContaining({ agentId: agent, actorType: "staff", actorId: "staff_1", applicationId: app }),
    ]);
  });
});

describe("decline", () => {
  async function pendingOffer() {
    const cycle = await openCycle(null);
    const { agent, app } = await shortlisted(cycle);
    const offer = await offerFor(app);
    clearAdmissionsAuditMem();
    return { offer, agent, app };
  }

  it("changes nothing when the actor does not own the offer", async () => {
    const { offer } = await pendingOffer();
    expect(await declineOfferAsAgentMem(offer.id, "d6_someone_else")).toBe(false);
    expect((await getOfferByIdMem(offer.id))!.status).toBe("pending");
    expect(readAdmissionsAuditMem()).toHaveLength(0);
  });

  it("changes nothing against a non-pending offer, so it is not repeatable", async () => {
    const { offer, agent } = await pendingOffer();
    expect(await declineOfferAsAgentMem(offer.id, agent)).toBe(true);
    expect(readAdmissionsAuditMem({ action: "decline" })).toHaveLength(1);

    expect(await declineOfferAsAgentMem(offer.id, agent)).toBe(false);
    expect(readAdmissionsAuditMem({ action: "decline" })).toHaveLength(1);
  });

  it("refuses a human with no link to the agent", async () => {
    const { offer } = await pendingOffer();
    expect(await declineOfferAsHumanMem(offer.id, "d6_human_unlinked")).toBe(false);
    expect((await getOfferByIdMem(offer.id))!.status).toBe("pending");
    expect(readAdmissionsAuditMem()).toHaveLength(0);
  });

  it("admits a linked human, and the offer, application and audit all move together", async () => {
    const { offer, agent } = await pendingOffer();
    const human = await link(agent);

    expect(await declineOfferAsHumanMem(offer.id, human)).toBe(true);
    expect((await getOfferByIdMem(offer.id))!.status).toBe("declined");
    expect(readAdmissionsAuditMem({ action: "decline" })).toEqual([
      expect.objectContaining({ actorType: "human", actorId: human, agentId: agent }),
    ]);
  });
});

describe("acceptance", () => {
  it("is idempotent: one timestamp and exactly one audit row across repeated calls", async () => {
    // The pre-D6 audit element asked only whether `accepted_at_agent IS NOT NULL`, which stays
    // true on retry — so every repeat rewrote the timestamp and appended another audit row.
    const cycle = await openCycle(null);
    const { agent, app } = await shortlisted(cycle);
    const offer = await offerFor(app);
    await link(agent); // a human is required, so acceptance waits rather than finalizing
    clearAdmissionsAuditMem();

    expect(await acceptOfferAsAgentMem(offer.id, agent)).toBe("ok");
    const firstStamp = (await getOfferByIdMem(offer.id))!.acceptedAtAgent;
    expect(firstStamp).not.toBeNull();

    expect(await acceptOfferAsAgentMem(offer.id, agent)).toBe("ok");
    expect(await acceptOfferAsAgentMem(offer.id, agent)).toBe("ok");

    expect((await getOfferByIdMem(offer.id))!.acceptedAtAgent).toBe(firstStamp);
    expect(readAdmissionsAuditMem({ action: "accept_agent" })).toHaveLength(1);
  });

  it("finalizes exactly once when both sides accept, however many times they call", async () => {
    const cycle = await openCycle(null);
    const { agent, app } = await shortlisted(cycle);
    const offer = await offerFor(app);
    const human = await link(agent);
    clearAdmissionsAuditMem();

    await acceptOfferAsAgentMem(offer.id, agent);
    await acceptOfferAsHumanMem(offer.id, human);
    // Repeats after the offer is already `fully_accepted` must transition nothing.
    await acceptOfferAsAgentMem(offer.id, agent);
    await acceptOfferAsHumanMem(offer.id, human);

    expect((await getOfferByIdMem(offer.id))!.status).toBe("fully_accepted");
    expect(admitted.has(agent)).toBe(true);
    expect(readAdmissionsAuditMem({ action: "admission_finalized" })).toHaveLength(1);
    expect(readAdmissionsAuditMem({ action: "accept_agent" })).toHaveLength(1);
    expect(readAdmissionsAuditMem({ action: "accept_human" })).toHaveLength(1);
  });

  it("finalizes on the agent's acceptance alone when no human is linked", async () => {
    const cycle = await openCycle(null);
    const { agent, app } = await shortlisted(cycle);
    const offer = await offerFor(app);

    expect(await acceptOfferAsAgentMem(offer.id, agent)).toBe("ok");
    expect((await getOfferByIdMem(offer.id))!.status).toBe("fully_accepted");
    expect(readAdmissionsAuditMem({ action: "admission_finalized" })).toHaveLength(1);
  });

  it("refuses a human with no link to the agent", async () => {
    const cycle = await openCycle(null);
    const { agent, app } = await shortlisted(cycle);
    const offer = await offerFor(app);
    await link(agent);

    expect(await acceptOfferAsHumanMem(offer.id, "d6_human_other")).toBe("invalid");
    expect((await getOfferByIdMem(offer.id))!.acceptedAtHuman).toBeNull();
    expect(readAdmissionsAuditMem({ action: "accept_human" })).toHaveLength(0);
  });
});
