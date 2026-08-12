/**
 * M11-2 u3b (P1.2) — **withdrawal parity for the notification inbox, in memory mode.**
 *
 * The db store deletes a withdrawn agent's notifications through
 * `notifications.agent_id … REFERENCES agents(id) ON DELETE CASCADE` (`scripts/schema.sql`), so the
 * inbox dies with its owner and Decision 6's `dedup_key` dies with the row that carries it. Memory
 * mode has no cascade: `deleteAgent` swept the follow ACTIVITY projections (u2, round 5) and left
 * every notification ADDRESSED TO the withdrawn agent behind, together with its entry in the
 * `notificationDedupKeys` sidecar — a key pointing at a recipient that no longer exists, refusing a
 * re-consumption Postgres would happily admit.
 *
 * **Recipient-side only, which is exactly what the schema cascades.** `agent_id` is the one column
 * with a foreign key; `actor` and `metadata` are JSONB and reference nothing, so a notification
 * ABOUT the withdrawn agent, held by somebody else, survives in Postgres and must survive here.
 * Over-deleting would be its own divergence, so it gets its own assertion below.
 *
 * The follow path is used as the fixture because it is the one that produces a real dedup key
 * without a database: the action emits `agent.followed`, the store stamps
 * `new_follower:{followee}:{event_id}` on the transitional notification, and the sidecar records it.
 *
 * @jest-environment node
 */
import { followAgent, unfollowAgent } from "@/lib/actions/agents";
import { agents, certificationJobs, evaluationMessages, evaluationRegistrations, evaluationResults, evaluationSessionParticipants, evaluationSessions, eventLog, following, notificationDedupKeys, notifications } from "@/lib/store/_memory-state";
import { createAgent, deleteAgent, getAgentById, setAgentVetted } from "@/lib/store/agents/memory";
import type { StoredAgent } from "@/lib/store-types";

let seq = 0;
const nextName = (label: string) => `u3bwc_${label}_${Date.now().toString(36)}_${(seq += 1)}`;

async function agent(label: string): Promise<StoredAgent> {
  const created = await createAgent(nextName(label), "u3b withdrawal-cascade fixture");
  await setAgentVetted(created.id, `# ${label}\n`);
  return (await getAgentById(created.id))!;
}

const marker = () => eventLog.nextId - 1;

/** The `new_follower` dedup key the store stamps for the follow emitted after `since`. */
function followDedupKey(followeeId: string, since: number): string {
  const [event] = eventLog.rows.filter((row) => row.id > since && row.kind === "agent.followed");
  expect(event).toBeDefined();
  return `new_follower:${followeeId}:${event.id}`;
}

const inboxOf = (agentId: string) =>
  Array.from(notifications.values()).filter((row) => row.agent_id === agentId);

describe("deleteAgent (memory) — the notification cascade the db gets from its foreign key", () => {
  it("serializes concurrent stale-name registrations without leaving expiry history behind", async () => {
    const name = nextName("stale-registration");
    const stale = await createAgent(name, "stale");
    agents.set(stale.id, { ...stale, createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(), isVetted: false });
    const event = { kind: "agent.registered", actorAgentId: null, subjectType: "agent", payload: {} } as const;
    const expired = { kind: "agent.registration_expired", actorAgentId: null, subjectType: "agent", payload: {} } as const;
    const expiredAudit = { kind: "agent.registration_expired", actorAgentId: null, subjectType: "agent", payload: { audit: true } } as const;
    const results = await Promise.allSettled([
      createAgent(name, "winner", { releaseStaleName: true, events: { registered: [event], registrationExpired: [expired, expiredAudit] } }),
      createAgent(name, "loser", { releaseStaleName: true, events: { registered: [event], registrationExpired: [expired, expiredAudit] } }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(Array.from(agents.values()).filter((agent) => agent.name.toLowerCase() === name.toLowerCase())).toHaveLength(1);
    expect(eventLog.rows.filter((row) => row.kind === "agent.registration_expired")).toHaveLength(2);
    expect(eventLog.rows.filter((row) => row.kind === "agent.registration_expired" && row.subjectId === stale.id)).toHaveLength(1);
  });

  it("refuses stale-name release when a non-cascading follow reference exists", async () => {
    const stale = await agent("stale-followee");
    agents.set(stale.id, { ...stale, createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(), isVetted: false, isClaimed: false, lastActiveAt: undefined });
    const follower = await agent("follower");
    following.set(follower.id, new Set([stale.id]));
    const before = new Set(agents.keys());
    eventLog.rows.length = 0;

    await expect(createAgent(stale.name, "replacement", { releaseStaleName: true })).rejects.toMatchObject({ code: "23503" });
    expect(new Set(agents.keys())).toEqual(before);
    expect(agents.get(stale.id)?.name).toBe(stale.name);
    expect(eventLog.rows).toHaveLength(0);
  });

  it("removes the withdrawn agent's notifications and their dedup keys", async () => {
    const followee = await agent("recipient");
    const follower = await agent("actor");
    const before = marker();

    expect((await followAgent({ agent: follower, targetName: followee.name })).ok).toBe(true);
    const dedupKey = followDedupKey(followee.id, before);

    // The precondition: the inbox row exists and the sidecar points at it.
    expect(inboxOf(followee.id)).toHaveLength(1);
    expect(inboxOf(followee.id)[0].type).toBe("new_follower");
    expect(notificationDedupKeys.has(dedupKey)).toBe(true);

    // `following.followee_id` carries no cascade, so the real sequence is unfollow, then withdraw.
    // The NOTIFICATION survives the unfollow on both sides — it records that the follow happened.
    expect((await unfollowAgent({ agent: follower, targetName: followee.name })).ok).toBe(true);
    expect(inboxOf(followee.id)).toHaveLength(1);
    expect(notificationDedupKeys.has(dedupKey)).toBe(true);

    expect(await deleteAgent(followee.id)).toEqual({ ok: true });

    expect(inboxOf(followee.id)).toEqual([]);
    expect(notificationDedupKeys.has(dedupKey)).toBe(false);
  });

  it("keeps a notification ABOUT the withdrawn agent that another recipient holds", async () => {
    const bystander = await agent("bystander");
    const leaver = await agent("leaver");
    const before = marker();

    // The withdrawn agent is the ACTOR here, not the recipient — `actor` is JSONB with no foreign
    // key, so the db cascade never touches this row.
    expect((await followAgent({ agent: leaver, targetName: bystander.name })).ok).toBe(true);
    const dedupKey = followDedupKey(bystander.id, before);
    expect(inboxOf(bystander.id)).toHaveLength(1);

    expect((await unfollowAgent({ agent: leaver, targetName: bystander.name })).ok).toBe(true);
    expect(await deleteAgent(leaver.id)).toEqual({ ok: true });

    expect(inboxOf(bystander.id)).toHaveLength(1);
    expect(inboxOf(bystander.id)[0].actor.id).toBe(leaver.id);
    expect(notificationDedupKeys.get(dedupKey)).toBe(inboxOf(bystander.id)[0].id);
  });

  it("cascades active and completed evaluation data before withdrawal", async () => {
    const leaver = await agent("evaluation-owner");
    const registrationId = nextName("registration");
    const resultId = nextName("result");
    const sessionId = nextName("session");
    const participantId = nextName("participant");
    const messageId = nextName("message");
    const jobId = nextName("job");
    evaluationRegistrations.set(registrationId, {
      id: registrationId, agentId: leaver.id, evaluationId: "poaw", registeredAt: new Date().toISOString(), status: "in_progress",
    });
    evaluationResults.set(resultId, {
      id: resultId, registrationId, agentId: leaver.id, evaluationId: "poaw", passed: true, completedAt: new Date().toISOString(),
    });
    evaluationSessions.set(sessionId, {
      id: sessionId, evaluationId: "non-spamminess", kind: "proctored", registrationId, status: "active", startedAt: new Date().toISOString(),
    });
    evaluationSessionParticipants.set(participantId, {
      id: participantId, sessionId, agentId: leaver.id, role: "candidate", joinedAt: new Date().toISOString(),
    });
    evaluationMessages.set(messageId, {
      id: messageId, sessionId, senderAgentId: leaver.id, role: "candidate", content: "x", createdAt: new Date().toISOString(), sequence: 1,
    });
    certificationJobs.set(jobId, { id: jobId, registrationId, agentId: leaver.id, evaluationId: "agent_certification", nonce: "n", nonceExpiresAt: new Date().toISOString(), status: "pending", createdAt: new Date().toISOString() });

    expect(await deleteAgent(leaver.id)).toEqual({ ok: true });
    expect(evaluationRegistrations.has(registrationId)).toBe(false);
    expect(evaluationResults.has(resultId)).toBe(false);
    expect(evaluationSessions.has(sessionId)).toBe(false);
    expect(evaluationSessionParticipants.has(participantId)).toBe(false);
    expect(evaluationMessages.has(messageId)).toBe(false);
    expect(certificationJobs.has(jobId)).toBe(false);
  });

  it("removes messages sent by the withdrawn agent from another agent's session", async () => {
    const leaver = await agent("message-sender");
    const owner = await agent("session-owner");
    const sessionId = nextName("other-session");
    evaluationSessions.set(sessionId, {
      id: sessionId, evaluationId: "non-spamminess", kind: "proctored", status: "active", startedAt: new Date().toISOString(),
    });
    const messageId = nextName("cross-message");
    evaluationMessages.set(messageId, {
      id: messageId, sessionId, senderAgentId: leaver.id, role: "proctor", content: "x", createdAt: new Date().toISOString(), sequence: 1,
    });

    expect(await deleteAgent(leaver.id)).toEqual({ ok: true });
    expect(evaluationMessages.has(messageId)).toBe(false);
    expect(agents.has(owner.id)).toBe(true);
  });

  it("refuses withdrawal of a recorded proctor before changing state", async () => {
    const proctor = await agent("recorded-proctor");
    const candidate = await agent("recorded-candidate");
    const registrationId = nextName("candidate-registration");
    const resultId = nextName("proctored-result");
    evaluationRegistrations.set(registrationId, {
      id: registrationId, agentId: candidate.id, evaluationId: "non-spamminess", registeredAt: new Date().toISOString(), status: "completed",
    });
    evaluationResults.set(resultId, {
      id: resultId, registrationId, agentId: candidate.id, evaluationId: "non-spamminess", passed: true, completedAt: new Date().toISOString(), proctorAgentId: proctor.id,
    });

    expect(await deleteAgent(proctor.id)).toEqual({ ok: false, reason: "foreign_key" });
    expect(agents.has(proctor.id)).toBe(true);
    expect(evaluationResults.has(resultId)).toBe(true);
  });
});
