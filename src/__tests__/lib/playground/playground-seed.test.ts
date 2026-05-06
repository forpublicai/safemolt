/**
 * @jest-environment node
 */

const unstableCacheStore = new Map<string, { createdAt: number; value: unknown }>();

jest.mock("next/cache", () => ({
  unstable_cache:
    (fn: () => Promise<unknown>, keyParts: string[], options?: { revalidate?: number }) =>
    async () => {
      const key = JSON.stringify(keyParts);
      const revalidateMs = (options?.revalidate ?? 0) * 1000;
      const hit = unstableCacheStore.get(key);
      if (hit && Date.now() - hit.createdAt < revalidateMs) {
        return hit.value;
      }

      const value = await fn();
      unstableCacheStore.set(key, { createdAt: Date.now(), value });
      return value;
    },
}));

jest.mock("@/lib/playground/games", () => ({
  listSchoolGameDefs: jest.fn(),
}));

jest.mock("@/lib/store", () => ({
  listPlaygroundSessions: jest.fn(),
}));

import { listSchoolGameDefs } from "@/lib/playground/games";
import { listPlaygroundSessions } from "@/lib/store";
import { getCachedPlaygroundSeed, getMemoizedSchoolGameDefs } from "@/lib/playground/playground-seed";

const mockedListSchoolGameDefs = jest.mocked(listSchoolGameDefs);
const mockedListPlaygroundSessions = jest.mocked(listPlaygroundSessions);

describe("playground seed cache", () => {
  beforeEach(() => {
    unstableCacheStore.clear();
    jest.clearAllMocks();
    mockedListSchoolGameDefs.mockReturnValue([
      {
        id: "trade-bazaar",
        name: "Trade Bazaar",
        description: "Trading.",
        premise: "Trade.",
        rules: "Rules.",
        scenes: [],
        minPlayers: 2,
        maxPlayers: 5,
        defaultMaxRounds: 5,
      },
    ]);
    mockedListPlaygroundSessions.mockResolvedValue([
      {
        id: "pg-1",
        gameId: "trade-bazaar",
        schoolId: "foundation",
        status: "active",
        participants: [],
        transcript: [],
        currentRound: 1,
        maxRounds: 5,
        createdAt: "2026-05-06T00:00:00.000Z",
      },
    ]);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("memoizes YAML game definitions by school id", () => {
    const first = getMemoizedSchoolGameDefs("foundation");
    const second = getMemoizedSchoolGameDefs("foundation");

    expect(first).toBe(second);
    expect(mockedListSchoolGameDefs).toHaveBeenCalledTimes(1);
  });

  it("serves the SSR seed from cache within the revalidate window", async () => {
    const nowSpy = jest.spyOn(Date, "now").mockReturnValue(0);

    await expect(getCachedPlaygroundSeed("foundation")()).resolves.toMatchObject({
      games: [{ id: "trade-bazaar" }],
      sessions: [{ id: "pg-1" }],
    });
    await getCachedPlaygroundSeed("foundation")();

    expect(mockedListPlaygroundSessions).toHaveBeenCalledTimes(1);

    nowSpy.mockReturnValue(6_000);
    await getCachedPlaygroundSeed("foundation")();

    expect(mockedListPlaygroundSessions).toHaveBeenCalledTimes(2);
  });

  it("keeps cached session lists isolated by school id", async () => {
    jest.spyOn(Date, "now").mockReturnValue(0);
    mockedListPlaygroundSessions.mockImplementation(async (options) => [
      {
        id: `pg-${options?.schoolId}`,
        gameId: "trade-bazaar",
        schoolId: options?.schoolId,
        status: "active",
        participants: [],
        transcript: [],
        currentRound: 1,
        maxRounds: 5,
        createdAt: "2026-05-06T00:00:00.000Z",
      },
    ]);

    await expect(getCachedPlaygroundSeed("foundation-isolated")()).resolves.toMatchObject({
      sessions: [{ id: "pg-foundation-isolated" }],
    });
    await expect(getCachedPlaygroundSeed("ao-isolated")()).resolves.toMatchObject({
      sessions: [{ id: "pg-ao-isolated" }],
    });
    await getCachedPlaygroundSeed("foundation-isolated")();

    expect(mockedListPlaygroundSessions).toHaveBeenCalledTimes(2);
    expect(mockedListPlaygroundSessions).toHaveBeenCalledWith({
      limit: 50,
      schoolId: "foundation-isolated",
    });
    expect(mockedListPlaygroundSessions).toHaveBeenCalledWith({
      limit: 50,
      schoolId: "ao-isolated",
    });
  });
});
