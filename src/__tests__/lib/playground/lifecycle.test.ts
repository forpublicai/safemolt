/**
 * @jest-environment node
 */

jest.mock("next/cache", () => ({
  revalidateTag: jest.fn(),
}));

// M11-2 P1.4: the cap no longer writes through the generic `updatePlaygroundSession`. It calls a
// CONDITIONAL completion that carries `playground.session_completed` with `reason: 'lifetime_cap'`,
// so the event can be gated on a transition that actually happened rather than on a setter that
// always reports success.
//
// **u3d fix round, finding 4: the ELIGIBILITY question moved into the store.** The sweep used to
// read the 50 newest active sessions and filter them by age here, which is exactly how an overdue
// session could be stranded — with 51 live sessions the oldest is not in that window at all. It now
// asks for the sessions that are DUE, oldest first, and pages. The age/`completed_at` predicate is
// therefore asserted against the real store in `playground-cap-eligibility.test.ts`; what is left
// here is the orchestration: the cutoff, the paging, and the revalidation.
jest.mock("@/lib/store", () => ({
  listSessionsDueForLifetimeCap: jest.fn(),
  completePlaygroundSessionAtLifetimeCap: jest.fn(),
}));

import { revalidateTag } from "next/cache";
import {
  completePlaygroundSessionAtLifetimeCap,
  listSessionsDueForLifetimeCap,
} from "@/lib/store";
import { enforceSessionLifetimeCap, runDeadlinesAndCap } from "@/lib/playground/lifecycle";
import type { PlaygroundSession } from "@/lib/playground/types";

const mockedListDueSessions = jest.mocked(listSessionsDueForLifetimeCap);
const mockedUpdatePlaygroundSession = jest.mocked(completePlaygroundSessionAtLifetimeCap);
const mockedRevalidateTag = jest.mocked(revalidateTag);

/** One page of due candidates, then nothing — the shape the store answers with. */
function duePages(...pages: PlaygroundSession[][]): void {
  for (const page of pages) mockedListDueSessions.mockResolvedValueOnce(page);
  mockedListDueSessions.mockResolvedValue([]);
}

/** A due candidate as the store would answer it — the sweep no longer re-checks its age. */
function staleSession(id: string, now: number): PlaygroundSession {
  return {
    id,
    gameId: "pub-debate",
    schoolId: "foundation",
    status: "active",
    participants: [],
    transcript: [],
    currentRound: 1,
    maxRounds: 6,
    createdAt: new Date(now - 10 * 60 * 60 * 1000).toISOString(),
    startedAt: new Date(now - 10 * 60 * 60 * 1000).toISOString(),
  };
}

describe("playground lifecycle", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("completes active sessions older than the wall-clock cap", async () => {
    const now = Date.now();
    jest.spyOn(Date, "now").mockReturnValue(now);
    duePages([
      {
        id: "pg-stale",
        gameId: "trade-bazaar",
        schoolId: "ao",
        status: "active",
        participants: [],
        transcript: [{ round: 1, gmPrompt: "p", actions: [], gmResolution: "r", resolvedAt: "old" }],
        currentRound: 5,
        currentRoundPrompt: "finish?",
        roundDeadline: new Date(now + 60_000).toISOString(),
        maxRounds: 5,
        createdAt: new Date(now - 10 * 60 * 60 * 1000).toISOString(),
        startedAt: new Date(now - 10 * 60 * 60 * 1000).toISOString(),
      },
    ]);
    mockedUpdatePlaygroundSession.mockResolvedValue(true);

    await expect(enforceSessionLifetimeCap()).resolves.toEqual({ completed: 1 });

    expect(mockedUpdatePlaygroundSession).toHaveBeenCalledWith(
      "pg-stale",
      { summary: "Session ran past its time budget and was completed automatically.", completedAt: new Date(now).toISOString() },
      [
        expect.objectContaining({
          kind: "playground.session_completed",
          payload: { reason: "lifetime_cap" },
        }),
      ]
    );
    expect(mockedUpdatePlaygroundSession).not.toHaveBeenCalledWith(
      "pg-stale",
      expect.objectContaining({ transcript: expect.anything() })
    );
    expect(mockedRevalidateTag).toHaveBeenCalledWith("playground-seed:ao");
  });

  it("asks the store for the sessions due at the cap, and does nothing when there are none", async () => {
    const now = Date.now();
    jest.spyOn(Date, "now").mockReturnValue(now);
    duePages([]);

    await expect(enforceSessionLifetimeCap()).resolves.toEqual({ completed: 0 });

    // The cutoff IS the age rule, handed to the store instead of applied to a fixed window here.
    expect(mockedListDueSessions).toHaveBeenCalledWith(
      new Date(now - 6 * 60 * 60 * 1000).toISOString(),
      50
    );
    expect(mockedListDueSessions).toHaveBeenCalledTimes(1);
    expect(mockedUpdatePlaygroundSession).not.toHaveBeenCalled();
    expect(mockedRevalidateTag).not.toHaveBeenCalled();
  });

  /**
   * **The starvation fix, at the orchestration level** (u3d fix round, finding 4).
   *
   * A full page means there may be more due sessions behind it, so the sweep asks again; the
   * candidates it just completed are no longer `active` with a NULL `completed_at`, so they cannot
   * come back. The old shape read ONE fixed window of the 50 newest active sessions and stopped —
   * which is how an overdue session sat behind 50 younger ones forever.
   */
  it("pages until a page comes back short", async () => {
    const now = Date.now();
    jest.spyOn(Date, "now").mockReturnValue(now);
    const page = (prefix: string) =>
      Array.from({ length: 50 }, (_, i) => staleSession(`${prefix}-${i}`, now));
    duePages(page("first"), page("second"), [staleSession("last", now)]);
    mockedUpdatePlaygroundSession.mockResolvedValue(true);

    await expect(enforceSessionLifetimeCap()).resolves.toEqual({ completed: 101 });
    expect(mockedListDueSessions).toHaveBeenCalledTimes(3);
  });

  it("bounds one invocation, leaving the rest for the next run", async () => {
    const now = Date.now();
    jest.spyOn(Date, "now").mockReturnValue(now);
    // Always a full page: an unbounded loop would never return. The ordering is what makes the bound
    // safe — the next run resumes at the sessions that have waited longest.
    mockedListDueSessions.mockImplementation(async () =>
      Array.from({ length: 50 }, (_, i) => staleSession(`endless-${i}`, now))
    );
    mockedUpdatePlaygroundSession.mockResolvedValue(true);

    await expect(enforceSessionLifetimeCap()).resolves.toEqual({ completed: 1000 });
    expect(mockedListDueSessions).toHaveBeenCalledTimes(20);
  });

  it("counts only the completions the conditional transition actually made", async () => {
    const now = Date.now();
    jest.spyOn(Date, "now").mockReturnValue(now);
    duePages([staleSession("won", now), staleSession("lost", now)]);
    // The second lost its CAS to a genuine GM completion that landed first.
    mockedUpdatePlaygroundSession.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    await expect(enforceSessionLifetimeCap()).resolves.toEqual({ completed: 1 });
  });

  it("preserves an existing summary when capping a stale session", async () => {
    const now = Date.now();
    jest.spyOn(Date, "now").mockReturnValue(now);
    duePages([
      {
        id: "pg-existing-summary",
        gameId: "trade-bazaar",
        status: "active",
        participants: [],
        transcript: [],
        currentRound: 5,
        roundDeadline: new Date(now + 60_000).toISOString(),
        maxRounds: 5,
        summary: "Existing summary",
        createdAt: new Date(now - 10 * 60 * 60 * 1000).toISOString(),
        startedAt: new Date(now - 10 * 60 * 60 * 1000).toISOString(),
      },
    ]);
    mockedUpdatePlaygroundSession.mockResolvedValue(true);

    await enforceSessionLifetimeCap();

    expect(mockedUpdatePlaygroundSession).toHaveBeenCalledWith(
      "pg-existing-summary",
      expect.objectContaining({ summary: "Existing summary" }),
      expect.any(Array)
    );
  });

  it("dedupes concurrent deadline runs with the same label", async () => {
    const runDeadlineCheck = jest.fn();
    let resolveRun: (value: { advanced: number; capped: number }) => void = () => {};
    runDeadlineCheck.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRun = resolve;
        })
    );

    const first = runDeadlinesAndCap("same-label", runDeadlineCheck);
    const second = await runDeadlinesAndCap("same-label", runDeadlineCheck);
    resolveRun({ advanced: 2, capped: 1 });

    await expect(first).resolves.toMatchObject({ advanced: 2, capped: 1 });
    expect(second).toEqual({ advanced: 0, capped: 0 });
    expect(runDeadlineCheck).toHaveBeenCalledTimes(1);
  });
});
