/**
 * M11-2 u3d fix round, finding 2 — **memory mode's crash window, closed.**
 *
 * The db side gets atomicity from Postgres: the transitional trail row is a CTE of the very
 * statement that writes the session and inserts the event, so all three land or none do (proven
 * against a real database by the failure-injection case in `m11-2-u3d-playground.test.ts`).
 *
 * Memory mode has no transaction, so its equivalent is Decision 4's: the mutation, the event append
 * and the projection are ONE synchronous section with no `await` between them. Before this round the
 * producers awaited the in-process dispatcher FIRST and only then called the best-effort projection
 * wrapper — so anything that failed or never returned in that window left the event appended with
 * no legacy projection and nothing that would ever write one.
 *
 * That window is directly observable, and this file observes it: the dispatcher is replaced by a
 * consumer whose `handleEvent` never settles, the producer is left pending on it, and the projection
 * must ALREADY be there. Under the old ordering it would not be — the producer would still be
 * suspended on `await dispatched` with the trail row unwritten.
 *
 * @jest-environment node
 */
import type { RegisteredConsumer } from "@/lib/events/consumers/dispatch";
import { __setMemoryEventConsumersForTests } from "@/lib/store/events/memory-dispatch";
import {
  activityEventKey,
  activityEventSourceIds,
  activityEvents,
  agents,
  eventLog,
  playgroundActions,
  playgroundSessions,
} from "@/lib/store/_memory-state";
import {
  createPlaygroundSession,
  submitPlaygroundActionGated,
} from "@/lib/store/playground/memory";
import { playgroundSessionCreatedEvent } from "@/lib/actions/playground-events";
import type { PreparedEvent } from "@/lib/events/kinds";

let release: () => void = () => {};

/**
 * A consumer that never finishes — the crash window, held open.
 *
 * `memoryModeDelivery: "await"` is the mode the real notification and activity consumers use, so
 * this reproduces the exact suspension point the producers used to sit on.
 */
function wedgedConsumer(): RegisteredConsumer {
  return {
    name: "wedged",
    memoryModeDelivery: "await",
    coverage: {} as RegisteredConsumer["coverage"],
    handleEvent: () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  } as unknown as RegisteredConsumer;
}

let seq = 0;
const nextId = (label: string) => `u3datom${label}${(seq += 1)}`;

beforeEach(() => {
  playgroundSessions.clear();
  playgroundActions.clear();
  activityEvents.clear();
  activityEventSourceIds.clear();
  agents.clear();
  eventLog.rows.length = 0;
  __setMemoryEventConsumersForTests([wedgedConsumer()]);
});

afterEach(() => {
  release();
  __setMemoryEventConsumersForTests(null);
});

/** Let every already-queued microtask run, without letting the wedged consumer finish. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

describe("the memory producers write their trail row in the SAME synchronous section", () => {
  it("has the session projection in place while the dispatcher is still wedged", async () => {
    const id = nextId("sess");
    const pending = createPlaygroundSession(
      {
        id,
        gameId: "pub-debate",
        schoolId: "foundation",
        status: "pending",
        participants: [],
        currentRound: 0,
        maxRounds: 6,
      },
      [playgroundSessionCreatedEvent({ actorAgentId: null, schoolId: "foundation" })]
    );
    let settled = false;
    void pending.then(() => {
      settled = true;
    });

    await flushMicrotasks();

    // Still suspended on the wedged consumer — this is the window a crash used to fall into.
    expect(settled).toBe(false);
    // ...and the projection is ALREADY written, stamped by the event the same section appended.
    const key = activityEventKey("playground_session", id);
    expect(activityEvents.get(key)).toBeDefined();
    expect(activityEventSourceIds.get(key)).toBe(eventLog.rows.at(-1)!.id);

    release();
    await pending;
  });

  it("has the ACTION projection in place while the dispatcher is still wedged", async () => {
    const agentId = nextId("agent");
    agents.set(agentId, { id: agentId, name: agentId } as never);
    const sessionId = nextId("sess");
    playgroundSessions.set(sessionId, {
      id: sessionId,
      gameId: "pub-debate",
      schoolId: "foundation",
      status: "active",
      participants: [{ agentId, agentName: agentId, status: "active" }],
      transcript: [],
      currentRound: 1,
      maxRounds: 6,
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
    });

    const actionId = nextId("act");
    const pending = submitPlaygroundActionGated(
      { id: actionId, sessionId, agentId, round: 1, content: "my move" },
      [
        {
          kind: "playground.action_submitted",
          actorAgentId: agentId,
          subjectType: "playground_session",
          subjectId: sessionId,
          schoolId: "foundation",
          idemKey: `playground_action:${sessionId}:1:${agentId}`,
          payload: { session_id: sessionId, round: 1, agent_id: agentId },
        } as PreparedEvent,
      ]
    );
    let settled = false;
    void pending.then(() => {
      settled = true;
    });

    await flushMicrotasks();

    expect(settled).toBe(false);
    const key = activityEventKey("playground_action", actionId);
    expect(activityEvents.get(key)).toBeDefined();
    expect(activityEventSourceIds.get(key)).toBe(eventLog.rows.at(-1)!.id);

    release();
    await pending;
  });
});
