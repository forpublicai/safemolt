/**
 * M11-2 u5 lane C (P3.2) deliverable 6, scenario 9 — the round-opening COMPOSITION in memory mode.
 *
 * Deliverable 4's suite (`wakeup-router.test.ts`) registers ONE consumer per emit: the router alone
 * for the wakeup cases, the notifications consumer alone for the inbox cases. That is deliberate
 * there — each block is proving one owner writes one projection and never the other's. What no test
 * covers, and what this file is for, is the shape production actually runs: **both consumers
 * registered against ONE `playground.round_opened`**, dispatched by the real memory-mode dispatcher.
 *
 * Three things only this arrangement can show:
 *
 *  - **Both effects are visible the instant the emitting store call resolves.** Decision 6 gives
 *    memory mode no worker and no cron, so `memoryModeDelivery: "await"` on both consumers is the
 *    whole delivery guarantee. A consumer that quietly became `background` — or one that threw and
 *    was swallowed by the dispatcher's never-throws contract — would leave the OTHER one's row in
 *    place and look healthy in a single-consumer test.
 *  - **They do not interfere.** The dispatcher runs them sequentially over one event; the router's
 *    write must not suppress the notification, and vice versa. One event, two independently owned
 *    rows per recipient.
 *  - **They agree on the recipient set, from the same live state.** Both re-derive "active, this
 *    round, has not acted" independently, so a divergence would show here as a wakeup with no
 *    notification (or the reverse) for one participant — which is precisely the asymmetry a
 *    per-consumer test cannot see.
 *
 * The stale cases repeat that argument in the negative: a session that has advanced past the event's
 * round, and one that has completed, must leave BOTH projections empty. A freshness gate that
 * regressed in only one consumer is a stale nudge in production and a green suite here without this
 * file.
 *
 * @jest-environment node
 */
jest.mock("@/lib/db", () => ({ hasDatabase: () => false, sql: null }));

import { notificationsConsumer } from "@/lib/events/consumers/notifications";
import { wakeupRouterConsumer } from "@/lib/events/consumers/wakeup-router";
import type { PreparedEvent } from "@/lib/events/kinds";
import type { PlaygroundSession, SessionAction } from "@/lib/playground/types";

let seq = 0;
const nextId = (label: string) => `u5d_${label}_${Date.now().toString(36)}_${(seq += 1)}`;

const PLAYGROUND_ROUND = "playground_round";
const ROUND_OPEN = "playground_round_open";

/** Every map this file writes, cleared between tests. */
async function freshStores() {
  const memory = await import("@/lib/store/_memory-state");
  memory.notifications.clear();
  memory.notificationDedupKeys.clear();
  memory.playgroundSessions.clear();
  memory.playgroundActions.clear();
  memory.resetWakeupState();
  memory.eventLog.rows.length = 0;
  memory.eventLog.nextId = 1;
  return memory;
}

/**
 * Seed a session straight into the memory map.
 *
 * Deliberately not through `createPlaygroundSession`: that emits `playground.session_created`, which
 * the injected consumer list would then dispatch, so the fixture would be writing state the
 * assertions are counting.
 */
async function seedSession(options: {
  status?: PlaygroundSession["status"];
  currentRound?: number;
  participants: { agentId: string; status?: "active" | "forfeited" }[];
}): Promise<PlaygroundSession> {
  const { playgroundSessions } = await import("@/lib/store/_memory-state");
  const session: PlaygroundSession = {
    id: nextId("sess"),
    gameId: "pub-debate",
    status: options.status ?? "active",
    participants: options.participants.map((p) => ({
      agentId: p.agentId,
      agentName: `${p.agentId}_name`,
      status: p.status ?? "active",
    })),
    transcript: [],
    currentRound: options.currentRound ?? 1,
    maxRounds: 6,
    createdAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
  };
  playgroundSessions.set(session.id, session);
  return session;
}

async function seedAction(sessionId: string, agentId: string, round: number): Promise<void> {
  const { playgroundActions } = await import("@/lib/store/_memory-state");
  const action: SessionAction = {
    id: nextId("act"),
    sessionId,
    agentId,
    round,
    content: "already moved",
    createdAt: new Date().toISOString(),
  };
  playgroundActions.set(action.id, action);
}

async function wakeupsFor(agentId: string) {
  const { listWakeupsForAgent } = await import("@/lib/store/wakeups/memory");
  return listWakeupsForAgent(agentId);
}

async function inboxOf(agentId: string) {
  const { listNotifications } = await import("@/lib/store/notifications/memory");
  return listNotifications(agentId);
}

/** Both consumers, in registry order, driven by the REAL memory-mode dispatcher. */
async function registerBothConsumers(): Promise<void> {
  const { __setMemoryEventConsumersForTests } = await import("@/lib/store/events");
  __setMemoryEventConsumersForTests([wakeupRouterConsumer, notificationsConsumer]);
}

async function emitRoundOpened(sessionId: string, round: number) {
  const { emitEvent } = await import("@/lib/store/events/memory");
  return emitEvent({
    kind: "playground.round_opened",
    subjectType: "playground_session",
    subjectId: sessionId,
    payload: { session_id: sessionId, round },
  } satisfies PreparedEvent<"playground.round_opened">);
}

afterEach(async () => {
  const { __setMemoryEventConsumersForTests } = await import("@/lib/store/events");
  __setMemoryEventConsumersForTests(null);
});

describe("memory-mode round opening — both consumers over one event", () => {
  /** Three active participants; one has already submitted for the round under test. */
  async function seedRound(currentRound = 3) {
    await freshStores();
    const acted = nextId("acted");
    const first = nextId("waiting");
    const second = nextId("waiting");
    const session = await seedSession({
      currentRound,
      participants: [{ agentId: acted }, { agentId: first }, { agentId: second }],
    });
    await seedAction(session.id, acted, currentRound);
    return { session, acted, first, second };
  }

  it("delivers BOTH the wakeup and the notification the instant the emit resolves", async () => {
    const { session, acted, first, second } = await seedRound();
    await registerBothConsumers();

    const emitted = await emitRoundOpened(session.id, 3);

    // No `await` of anything else between the emit and these reads beyond the reads themselves —
    // both consumers declare `memoryModeDelivery: "await"`, so the dispatcher has already run them
    // by the time the store call resolves. There is no cron and no worker in this mode.
    for (const agentId of [first, second]) {
      const woken = await wakeupsFor(agentId);
      expect(woken).toHaveLength(1);
      expect(woken[0]).toMatchObject({
        agentId,
        reason: PLAYGROUND_ROUND,
        eventId: emitted.id,
        delivery: "internal",
        payload: { session_id: session.id, round: 3 },
      });

      const inbox = await inboxOf(agentId);
      expect(inbox).toHaveLength(1);
      expect(inbox[0]).toMatchObject({
        type: ROUND_OPEN,
        priority: "normal",
        read_at: null,
        actor: { id: "system", name: "Game Master" },
        target: { type: "playground_session", id: session.id },
        href: "/playground",
        metadata: { session_id: session.id, round: 3 },
      });
    }

    // The participant who already moved gets NEITHER — both consumers filter the same set, from the
    // same live rows, and a divergence would show up here as one of the two present.
    expect(await wakeupsFor(acted)).toEqual([]);
    expect(await inboxOf(acted)).toEqual([]);
  });

  it("delivers neither once the session has advanced past the event's round", async () => {
    const { session, acted, first, second } = await seedRound();
    const { playgroundSessions } = await import("@/lib/store/_memory-state");
    // Genuinely moved on: round 4 is live, and the round-3 event below is a delayed delivery.
    playgroundSessions.set(session.id, { ...session, currentRound: 4 });
    await registerBothConsumers();

    await emitRoundOpened(session.id, 3);

    for (const agentId of [acted, first, second]) {
      expect(await wakeupsFor(agentId)).toEqual([]);
      expect(await inboxOf(agentId)).toEqual([]);
    }
  });

  it("delivers neither once the session has completed", async () => {
    const { session, first, second } = await seedRound();
    const { playgroundSessions } = await import("@/lib/store/_memory-state");
    playgroundSessions.set(session.id, { ...session, status: "completed" });
    await registerBothConsumers();

    await emitRoundOpened(session.id, 3);

    for (const agentId of [first, second]) {
      expect(await wakeupsFor(agentId)).toEqual([]);
      expect(await inboxOf(agentId)).toEqual([]);
    }
  });

  /**
   * A fresh round is a fresh EVENT, so both keys move with it: the wakeup's `(agent, reason,
   * event_id)` triple and the notification's `{type}:{recipient}:{event_id}`. Two rounds in a row
   * therefore leave two of each — while re-emitting the SAME round's event leaves one of each.
   */
  it("keys both projections to the EVENT, so a second round adds one of each and a redelivery adds none", async () => {
    const { session, first } = await seedRound(1);
    const { playgroundSessions } = await import("@/lib/store/_memory-state");
    await registerBothConsumers();

    const round1 = await emitRoundOpened(session.id, 1);
    playgroundSessions.set(session.id, { ...session, currentRound: 2 });
    const round2 = await emitRoundOpened(session.id, 2);

    expect((await wakeupsFor(first)).map((w) => w.eventId).sort((a, b) => Number(a) - Number(b))).toEqual([
      round1.id,
      round2.id,
    ]);
    expect((await inboxOf(first)).map((n) => n.metadata.round).sort()).toEqual([1, 2]);

    // A redelivery of the live round's event is the ordinary at-least-once case: the wakeup's dedup
    // index and the notification's dedup key each absorb it, so neither grows.
    await wakeupRouterConsumer.handleEvent({
      id: round2.id,
      kind: "playground.round_opened",
      actorAgentId: null,
      subjectType: "playground_session",
      subjectId: session.id,
      secondarySubjectId: null,
      schoolId: null,
      idemKey: null,
      payload: { session_id: session.id, round: 2 },
      createdAt: new Date().toISOString(),
    });
    await notificationsConsumer.handleEvent({
      id: round2.id,
      kind: "playground.round_opened",
      actorAgentId: null,
      subjectType: "playground_session",
      subjectId: session.id,
      secondarySubjectId: null,
      schoolId: null,
      idemKey: null,
      payload: { session_id: session.id, round: 2 },
      createdAt: new Date().toISOString(),
    });

    expect(await wakeupsFor(first)).toHaveLength(2);
    expect(await inboxOf(first)).toHaveLength(2);
  });
});
