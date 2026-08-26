/**
 * M11-2 u6 E fix round 1 — the sweep's three scans PAGE, against the real memory store.
 *
 * The db twins run the same predicates in SQL and the integration suite proves them against Postgres
 * with populations larger than one page; this file is the memory half, which Jest and local no-DB
 * development actually run. All three scans gained the same parameter for the same reason:
 *
 *  - `listActiveSessionsDueForRound` (finding 3): a FAILED advance leaves `roundDeadline` untouched,
 *    so a page whose rows all failed is still due and comes back identically. Excluding what the
 *    caller already attempted is what makes the next page hold something new.
 *  - `listPendingSessionsForActivationScan` (finding 4): eligibility is decided against the
 *    TypeScript game registry and cannot be a query predicate at all, so an under-subscribed lobby
 *    never leaves this set — fifty of them are a permanent wall without the exclusion.
 *  - `listActiveSessionsForArmScan` (finding 2): the round_opened bridge and the wakeup re-arm read
 *    the NEWEST fifty actives, so the OLDEST un-armed session was outside every sweep's window. It
 *    is now oldest-first, and arming changes nothing the query filters on — so, again, the exclusion
 *    is the only thing that makes a second page different from the first.
 *
 * @jest-environment node
 */
import {
  listActiveSessionsDueForRound,
  listActiveSessionsForArmScan,
  listPendingSessionsForActivationScan,
} from "@/lib/store/playground/memory";
import { playgroundSessions } from "@/lib/store/_memory-state";
import type { PlaygroundSession } from "@/lib/playground/types";

const NOW = Date.now();
const MINUTE = 60_000;

function seed(id: string, overrides: Partial<PlaygroundSession> = {}): void {
  playgroundSessions.set(id, {
    id,
    gameId: "pub-debate",
    schoolId: `school_${id}`,
    status: "active",
    participants: [],
    transcript: [],
    currentRound: 1,
    maxRounds: 6,
    createdAt: new Date(NOW - 60 * MINUTE).toISOString(),
    startedAt: new Date(NOW - 60 * MINUTE).toISOString(),
    ...overrides,
  });
}

beforeEach(() => {
  playgroundSessions.clear();
});

describe("listActiveSessionsDueForRound", () => {
  it("answers the most-overdue rounds first and skips the ones not yet due", async () => {
    seed("due-oldest", { roundDeadline: new Date(NOW - 30 * MINUTE).toISOString() });
    seed("due-newest", { roundDeadline: new Date(NOW - MINUTE).toISOString() });
    seed("not-due", { roundDeadline: new Date(NOW + 30 * MINUTE).toISOString() });
    seed("no-deadline");
    seed("completed", {
      status: "completed",
      roundDeadline: new Date(NOW - 30 * MINUTE).toISOString(),
    });

    const due = await listActiveSessionsDueForRound(50);
    expect(due.map((s) => s.id)).toEqual(["due-oldest", "due-newest"]);
  });

  /**
   * The starvation shape, at the store: the caller has attempted the first page and every one of
   * those advances failed, so all of them are still due. Without the exclusion this answer is the
   * same page again and the caller can never reach `behind`.
   */
  it("excludes the ids the caller already attempted this pass", async () => {
    const attempted: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const id = `failed${i}`;
      attempted.push(id);
      seed(id, { roundDeadline: new Date(NOW - (30 - i) * MINUTE).toISOString() });
    }
    seed("behind", { roundDeadline: new Date(NOW - MINUTE).toISOString() });

    // Unfiltered, the failed three own the front of the queue.
    expect((await listActiveSessionsDueForRound(3)).map((s) => s.id)).toEqual(attempted);
    // Excluded, the caller reaches the row behind them.
    expect((await listActiveSessionsDueForRound(3, attempted)).map((s) => s.id)).toEqual(["behind"]);
  });

  it("treats an empty exclusion list as no exclusion at all", async () => {
    seed("due", { roundDeadline: new Date(NOW - MINUTE).toISOString() });
    expect((await listActiveSessionsDueForRound(50, [])).map((s) => s.id)).toEqual(["due"]);
  });
});

describe("listPendingSessionsForActivationScan", () => {
  it("answers pending sessions oldest-created-first, excluding what the pass already examined", async () => {
    const examined: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const id = `lobby${i}`;
      examined.push(id);
      seed(id, {
        status: "pending",
        createdAt: new Date(NOW - (30 - i) * MINUTE).toISOString(),
        startedAt: undefined,
      });
    }
    seed("eligible", {
      status: "pending",
      createdAt: new Date(NOW - MINUTE).toISOString(),
      startedAt: undefined,
    });
    seed("active-one");

    expect((await listPendingSessionsForActivationScan(3)).map((s) => s.id)).toEqual(examined);
    expect((await listPendingSessionsForActivationScan(3, examined)).map((s) => s.id)).toEqual([
      "eligible",
    ]);
  });
});

describe("listActiveSessionsForArmScan", () => {
  it("answers EVERY active session oldest-first — the newest is last, not first", async () => {
    seed("newest", { startedAt: new Date(NOW - MINUTE).toISOString() });
    seed("oldest", { startedAt: new Date(NOW - 90 * MINUTE).toISOString() });
    seed("middle", { startedAt: new Date(NOW - 45 * MINUTE).toISOString() });
    seed("pending-one", { status: "pending", startedAt: undefined });

    const page = await listActiveSessionsForArmScan(50);
    expect(page.map((s) => s.id)).toEqual(["oldest", "middle", "newest"]);
  });

  it("falls back to createdAt for a session with no startedAt", async () => {
    seed("started", { startedAt: new Date(NOW - 10 * MINUTE).toISOString() });
    seed("only-created", {
      startedAt: undefined,
      createdAt: new Date(NOW - 90 * MINUTE).toISOString(),
    });

    expect((await listActiveSessionsForArmScan(50)).map((s) => s.id)).toEqual([
      "only-created",
      "started",
    ]);
  });

  /**
   * Arming changes nothing this query filters on, so the exclusion is the ONLY thing that makes the
   * caller's second page different from its first — the reason the arm scan needs the parameter even
   * though its rows never become ineligible.
   */
  it("pages through the whole population by excluding what has been examined", async () => {
    for (let i = 0; i < 5; i += 1) {
      seed(`s${i}`, { startedAt: new Date(NOW - (50 - i) * MINUTE).toISOString() });
    }

    const first = await listActiveSessionsForArmScan(2);
    expect(first.map((s) => s.id)).toEqual(["s0", "s1"]);
    const second = await listActiveSessionsForArmScan(2, first.map((s) => s.id));
    expect(second.map((s) => s.id)).toEqual(["s2", "s3"]);
    const third = await listActiveSessionsForArmScan(2, [...first, ...second].map((s) => s.id));
    expect(third.map((s) => s.id)).toEqual(["s4"]);
  });

  /** Same-instant fixtures are ordinary in memory mode, so the id tie-break has to be real. */
  it("breaks a timestamp tie by id, so a page boundary cannot drop a session", async () => {
    const sameInstant = new Date(NOW - 5 * MINUTE).toISOString();
    seed("b-tie", { startedAt: sameInstant });
    seed("a-tie", { startedAt: sameInstant });
    seed("c-tie", { startedAt: sameInstant });

    expect((await listActiveSessionsForArmScan(50)).map((s) => s.id)).toEqual([
      "a-tie",
      "b-tie",
      "c-tie",
    ]);
  });
});
