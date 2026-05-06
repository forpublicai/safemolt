/**
 * @jest-environment node
 */

jest.mock("next/cache", () => ({
  revalidateTag: jest.fn(),
}));

jest.mock("@/lib/store", () => ({
  listPlaygroundSessions: jest.fn(),
  updatePlaygroundSession: jest.fn(),
}));

import { revalidateTag } from "next/cache";
import { listPlaygroundSessions, updatePlaygroundSession } from "@/lib/store";
import { enforceSessionLifetimeCap, runDeadlinesAndCap } from "@/lib/playground/lifecycle";

const mockedListPlaygroundSessions = jest.mocked(listPlaygroundSessions);
const mockedUpdatePlaygroundSession = jest.mocked(updatePlaygroundSession);
const mockedRevalidateTag = jest.mocked(revalidateTag);

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
    mockedListPlaygroundSessions.mockResolvedValue([
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

    expect(mockedUpdatePlaygroundSession).toHaveBeenCalledWith("pg-stale", {
      status: "completed",
      summary: "Session ran past its time budget and was completed automatically.",
      completedAt: new Date(now).toISOString(),
      currentRoundPrompt: null,
      roundDeadline: null,
    });
    expect(mockedUpdatePlaygroundSession).not.toHaveBeenCalledWith(
      "pg-stale",
      expect.objectContaining({ transcript: expect.anything() })
    );
    expect(mockedRevalidateTag).toHaveBeenCalledWith("playground-seed:ao");
  });

  it("skips stale active sessions that already have completedAt set", async () => {
    const now = Date.now();
    jest.spyOn(Date, "now").mockReturnValue(now);
    mockedListPlaygroundSessions.mockResolvedValue([
      {
        id: "pg-already-completed",
        gameId: "pub-debate",
        status: "active",
        participants: [],
        transcript: [],
        currentRound: 4,
        roundDeadline: new Date(now - 60_000).toISOString(),
        maxRounds: 4,
        createdAt: new Date(now - 10 * 60 * 60 * 1000).toISOString(),
        startedAt: new Date(now - 10 * 60 * 60 * 1000).toISOString(),
        completedAt: new Date(now - 30_000).toISOString(),
      },
    ]);

    await expect(enforceSessionLifetimeCap()).resolves.toEqual({ completed: 0 });

    expect(mockedUpdatePlaygroundSession).not.toHaveBeenCalled();
    expect(mockedRevalidateTag).not.toHaveBeenCalled();
  });

  it("leaves active sessions under the cap alone", async () => {
    const now = Date.now();
    jest.spyOn(Date, "now").mockReturnValue(now);
    mockedListPlaygroundSessions.mockResolvedValue([
      {
        id: "pg-fresh",
        gameId: "tennis",
        status: "active",
        participants: [],
        transcript: [],
        currentRound: 1,
        roundDeadline: new Date(now + 60_000).toISOString(),
        maxRounds: 6,
        createdAt: new Date(now - 30 * 60 * 1000).toISOString(),
        startedAt: new Date(now - 30 * 60 * 1000).toISOString(),
      },
    ]);

    await expect(enforceSessionLifetimeCap()).resolves.toEqual({ completed: 0 });

    expect(mockedUpdatePlaygroundSession).not.toHaveBeenCalled();
    expect(mockedRevalidateTag).not.toHaveBeenCalled();
  });

  it("falls back to createdAt when an active stale session has no startedAt", async () => {
    const now = Date.now();
    jest.spyOn(Date, "now").mockReturnValue(now);
    mockedListPlaygroundSessions.mockResolvedValue([
      {
        id: "pg-missing-started-at",
        gameId: "tennis",
        status: "active",
        participants: [],
        transcript: [],
        currentRound: 3,
        roundDeadline: new Date(now + 60_000).toISOString(),
        maxRounds: 6,
        createdAt: new Date(now - 10 * 60 * 60 * 1000).toISOString(),
      },
    ]);
    mockedUpdatePlaygroundSession.mockResolvedValue(true);

    await expect(enforceSessionLifetimeCap()).resolves.toEqual({ completed: 1 });

    expect(mockedUpdatePlaygroundSession).toHaveBeenCalledWith(
      "pg-missing-started-at",
      expect.objectContaining({ status: "completed" })
    );
  });

  it("preserves an existing summary when capping a stale session", async () => {
    const now = Date.now();
    jest.spyOn(Date, "now").mockReturnValue(now);
    mockedListPlaygroundSessions.mockResolvedValue([
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
      expect.objectContaining({ summary: "Existing summary" })
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
