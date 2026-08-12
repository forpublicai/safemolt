/**
 * M11-2 u3d fix round, finding 4 — the lifetime cap's ELIGIBILITY QUERY.
 *
 * The sweep used to read the 50 NEWEST active sessions (`created_at DESC`) and filter them by age in
 * JavaScript. That window is the defect the round closes: with 51 live sessions the oldest is not in
 * it at all, so a session that had already blown its budget was skipped by every sweep while the
 * newest 50 were still young, and continuous creation stranded it indefinitely.
 *
 * Three properties make the replacement correct, and all three are asserted here against the real
 * memory store (the db twin runs the same predicate in SQL, and the integration suite proves it
 * against Postgres with 51 live sessions):
 *
 *  1. **The age predicate is IN the query**, so no fixed window can hide a due session.
 *  2. **The order is oldest-first**, so a bounded run always takes the sessions that have waited
 *     longest — which is what turns the cap's page bound into a delay rather than starvation.
 *  3. **`completedAt` is part of the predicate**, which is what makes the caller's paging terminate:
 *     every row returned is one the conditional completion either transitions or loses to a writer
 *     that already changed the same columns, so it cannot come back on the next page.
 *
 * @jest-environment node
 */
import { listSessionsDueForLifetimeCap } from "@/lib/store/playground/memory";
import { playgroundSessions } from "@/lib/store/_memory-state";
import type { PlaygroundSession } from "@/lib/playground/types";

const NOW = Date.parse("2026-08-05T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const CUTOFF = new Date(NOW - 6 * HOUR).toISOString();

function seed(id: string, overrides: Partial<PlaygroundSession> = {}): PlaygroundSession {
  const session: PlaygroundSession = {
    id,
    gameId: "pub-debate",
    schoolId: `school_${id}`,
    status: "active",
    participants: [],
    transcript: [],
    currentRound: 1,
    maxRounds: 6,
    createdAt: new Date(NOW - 10 * HOUR).toISOString(),
    startedAt: new Date(NOW - 10 * HOUR).toISOString(),
    ...overrides,
  };
  playgroundSessions.set(id, session);
  return session;
}

beforeEach(() => {
  playgroundSessions.clear();
});

describe("listSessionsDueForLifetimeCap", () => {
  it("answers only the sessions past the cutoff, oldest first", async () => {
    seed("young", { startedAt: new Date(NOW - HOUR).toISOString() });
    seed("oldest", { startedAt: new Date(NOW - 48 * HOUR).toISOString() });
    seed("middling", { startedAt: new Date(NOW - 9 * HOUR).toISOString() });

    const due = await listSessionsDueForLifetimeCap(CUTOFF, 50);
    expect(due.map((session) => session.id)).toEqual(["oldest", "middling"]);
  });

  /**
   * **The starvation case, at the store.** 51 live sessions, exactly one of them overdue and it is
   * the OLDEST — which is precisely the row the pre-fix "50 newest active sessions" window excluded.
   */
  it("finds the one overdue session behind fifty younger ones", async () => {
    seed("overdue", { startedAt: new Date(NOW - 24 * HOUR).toISOString() });
    for (let i = 0; i < 50; i += 1) {
      seed(`fresh${i}`, { startedAt: new Date(NOW - i * 60_000).toISOString() });
    }

    const due = await listSessionsDueForLifetimeCap(CUTOFF, 50);
    expect(due.map((session) => session.id)).toEqual(["overdue"]);
  });

  it("excludes a session that already carries completedAt, so a page cannot repeat it", async () => {
    seed("settled", { completedAt: new Date(NOW - 30_000).toISOString() });
    seed("due");

    const due = await listSessionsDueForLifetimeCap(CUTOFF, 50);
    expect(due.map((session) => session.id)).toEqual(["due"]);
  });

  it("excludes every non-active status", async () => {
    seed("pending", { status: "pending" });
    seed("cancelled", { status: "cancelled" });
    seed("completed", { status: "completed" });
    seed("active");

    const due = await listSessionsDueForLifetimeCap(CUTOFF, 50);
    expect(due.map((session) => session.id)).toEqual(["active"]);
  });

  it("falls back to createdAt when a session never recorded a start", async () => {
    seed("no-start", { startedAt: undefined, createdAt: new Date(NOW - 9 * HOUR).toISOString() });

    const due = await listSessionsDueForLifetimeCap(CUTOFF, 50);
    expect(due.map((session) => session.id)).toEqual(["no-start"]);
  });

  it("caps the page at the requested size, keeping the oldest", async () => {
    for (let i = 0; i < 5; i += 1) {
      seed(`due${i}`, { startedAt: new Date(NOW - (20 - i) * HOUR).toISOString() });
    }

    const due = await listSessionsDueForLifetimeCap(CUTOFF, 2);
    expect(due.map((session) => session.id)).toEqual(["due0", "due1"]);
  });
});
