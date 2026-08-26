/**
 * P4.1 leaf sections: evaluations, network, news, memories, admissions and limits. Each is its
 * own error boundary, so each gets a happy path and a thrown-read path. The admissions case is
 * the contract test: the five pinned agent-UX fields must survive the pass-through untouched.
 */

jest.mock("@/lib/store", () => ({
  getPassedEvaluations: jest.fn(),
  getFollowingCount: jest.fn(),
}));
jest.mock("@/lib/evaluations/loader", () => ({ listEvaluations: jest.fn(() => []) }));
jest.mock("@/lib/rss", () => ({ getNewsItems: jest.fn() }));
jest.mock("@/lib/memory/memory-service", () => ({ recallMemoryForAgent: jest.fn() }));
jest.mock("@/lib/admissions", () => ({ getAdmissionsStatusForAgent: jest.fn() }));
jest.mock("@/lib/agent-loop/state", () => ({ readLoopStateSafely: jest.fn() }));

import type { StoredAgent } from "@/lib/store-types";
import type { AdmissionsStatusPayload } from "@/lib/admissions";
import { gatherEvaluations } from "@/lib/agent-senses/evaluations";
import { gatherNetwork } from "@/lib/agent-senses/network";
import { gatherNews } from "@/lib/agent-senses/news";
import { gatherMemories } from "@/lib/agent-senses/memories";
import { gatherAdmissions } from "@/lib/agent-senses/admissions";
import { gatherLimits } from "@/lib/agent-senses/limits";
import { getFollowingCount, getPassedEvaluations } from "@/lib/store";
import { listEvaluations } from "@/lib/evaluations/loader";
import { getNewsItems } from "@/lib/rss";
import { recallMemoryForAgent } from "@/lib/memory/memory-service";
import { getAdmissionsStatusForAgent } from "@/lib/admissions";
import { readLoopStateSafely } from "@/lib/agent-loop/state";
import {
  COMMENT_COOLDOWN_MS,
  MAX_COMMENTS_PER_DAY,
  POST_COOLDOWN_MS,
} from "@/lib/store/rate-limit-windows";

const mockedGetPassed = jest.mocked(getPassedEvaluations);
const mockedListEvaluations = jest.mocked(listEvaluations);
const mockedFollowingCount = jest.mocked(getFollowingCount);
const mockedGetNewsItems = jest.mocked(getNewsItems);
const mockedRecall = jest.mocked(recallMemoryForAgent);
const mockedAdmissions = jest.mocked(getAdmissionsStatusForAgent);
const mockedLoopState = jest.mocked(readLoopStateSafely);

const agent = { id: "agent_1", name: "loopster", followerCount: 12 } as StoredAgent;

beforeEach(() => {
  jest.clearAllMocks();
});

describe("gatherEvaluations", () => {
  it("drops already-passed evaluations and caps the rest", async () => {
    mockedListEvaluations.mockReturnValue([
      { id: "e1", name: "First" },
      { id: "e2", name: "Second" },
      { id: "e3", name: "Third" },
      { id: "e4", name: "Fourth" },
    ] as never);
    mockedGetPassed.mockResolvedValue(["e1"] as never);

    const section = await gatherEvaluations("me");

    expect(mockedListEvaluations).toHaveBeenCalledWith("foundation", undefined, "active");
    expect(section).toEqual({
      degraded: false,
      items: [
        { id: "e2", name: "Second" },
        { id: "e3", name: "Third" },
        { id: "e4", name: "Fourth" },
      ],
    });
    await expect(gatherEvaluations("me", { limit: 1 })).resolves.toEqual({
      degraded: false,
      items: [{ id: "e2", name: "Second" }],
    });
  });

  it("degrades on a thrown read", async () => {
    mockedListEvaluations.mockReturnValue([] as never);
    mockedGetPassed.mockRejectedValue(new Error("boom"));
    await expect(gatherEvaluations("me")).resolves.toEqual({ items: [], degraded: true });
  });
});

describe("gatherNetwork", () => {
  it("pairs the follower count on the agent row with the stored following count", async () => {
    mockedFollowingCount.mockResolvedValue(4 as never);
    await expect(gatherNetwork(agent)).resolves.toEqual({
      data: { followerCount: 12, followingCount: 4 },
      degraded: false,
    });
  });

  it("keeps the half it already holds when the following count read throws", async () => {
    mockedFollowingCount.mockRejectedValue(new Error("boom"));
    await expect(gatherNetwork(agent)).resolves.toEqual({
      data: { followerCount: 12, followingCount: 0 },
      degraded: true,
    });
  });
});

describe("gatherNews", () => {
  it("returns headlines at the requested limit", async () => {
    mockedGetNewsItems.mockResolvedValue([{ title: "Something happened" }] as never);
    const section = await gatherNews(5);
    expect(mockedGetNewsItems).toHaveBeenCalledWith(5);
    expect(section).toEqual({ items: [{ title: "Something happened" }], degraded: false });
  });

  it("separates a quiet feed from a failed fetch", async () => {
    mockedGetNewsItems.mockResolvedValueOnce([] as never);
    await expect(gatherNews(5)).resolves.toEqual({ items: [], degraded: false });

    mockedGetNewsItems.mockRejectedValueOnce(new Error("boom"));
    await expect(gatherNews(5)).resolves.toEqual({ items: [], degraded: true });
  });
});

describe("gatherMemories", () => {
  it("recalls hot memories with the loop's own query and maps them to text", async () => {
    mockedRecall.mockResolvedValue([
      { id: "m1", text: "I argued about incentives", score: 1, metadata: {} },
    ] as never);

    const section = await gatherMemories("me");

    expect(mockedRecall).toHaveBeenCalledWith(
      "me",
      "hot",
      "my recent SafeMolt activity and conversations",
      8
    );
    expect(section).toEqual({ items: [{ text: "I argued about incentives" }], degraded: false });
  });

  it("degrades on a thrown recall", async () => {
    mockedRecall.mockRejectedValue(new Error("boom"));
    await expect(gatherMemories("me", { limit: 2 })).resolves.toEqual({
      items: [],
      degraded: true,
    });
  });
});

describe("gatherAdmissions", () => {
  const payload = {
    pool_eligible: true,
    public_ai_eligibility: { status: "eligible", reason: "vetted and loop-enabled" },
    next_action: { code: "submit_application", message: "Submit your application", href: "/apply" },
    criteria_progress: [
      { code: "vetted", label: "Proof of agentic work", complete: true },
      { code: "posted", label: "First post", complete: false },
    ],
    admission_source: "offer",
    state_source: "agent_flag",
    is_admitted: true,
    cycle_id: "cycle_7",
    application: null,
    offer: null,
  } as unknown as AdmissionsStatusPayload;

  it("passes the pinned contract fields through unmodified", async () => {
    mockedAdmissions.mockResolvedValue(payload);

    const section = await gatherAdmissions("me");

    expect(mockedAdmissions).toHaveBeenCalledWith("me");
    expect(section.degraded).toBe(false);
    // The five pinned fields, each with a distinguishable value.
    expect(section.data?.next_action).toEqual({
      code: "submit_application",
      message: "Submit your application",
      href: "/apply",
    });
    expect(section.data?.criteria_progress).toEqual([
      { code: "vetted", label: "Proof of agentic work", complete: true },
      { code: "posted", label: "First post", complete: false },
    ]);
    expect(section.data?.public_ai_eligibility).toEqual({
      status: "eligible",
      reason: "vetted and loop-enabled",
    });
    expect(section.data?.admission_source).toBe("offer");
    expect(section.data?.state_source).toBe("agent_flag");
    // Nothing is reshaped or dropped: the whole payload is the section's data.
    expect(section.data).toEqual(payload);
  });

  it("degrades to a null payload when the status read throws", async () => {
    mockedAdmissions.mockRejectedValue(new Error("boom"));
    await expect(gatherAdmissions("me")).resolves.toEqual({ data: null, degraded: true });
  });
});

describe("gatherLimits", () => {
  it("quotes the enforced rate windows and this agent's loop cooldown", async () => {
    mockedLoopState.mockResolvedValue({
      agentId: "me",
      enabled: true,
      lastSeenAt: null,
      lastActionAt: null,
      nextEligibleAt: "2026-08-26T12:00:00.000Z",
      lastError: null,
      actionsTaken: 3,
      errors: 0,
    });

    const section = await gatherLimits("me");

    expect(section).toEqual({
      degraded: false,
      data: {
        postCooldownMs: POST_COOLDOWN_MS,
        commentCooldownMs: COMMENT_COOLDOWN_MS,
        maxCommentsPerDay: MAX_COMMENTS_PER_DAY,
        loopNextEligibleAt: "2026-08-26T12:00:00.000Z",
      },
    });
    // The published numbers, pinned here so a silent drift is visible.
    expect(section.data.postCooldownMs).toBe(30_000);
    expect(section.data.commentCooldownMs).toBe(20_000);
    expect(section.data.maxCommentsPerDay).toBe(50);
  });

  it("answers a null cooldown when no loop state exists (or no database)", async () => {
    mockedLoopState.mockResolvedValue(null);
    const section = await gatherLimits("me");
    expect(section.degraded).toBe(false);
    expect(section.data.loopNextEligibleAt).toBeNull();
  });

  it("still answers the windows if the loop-state read throws against its contract", async () => {
    mockedLoopState.mockRejectedValue(new Error("boom"));
    const section = await gatherLimits("me");
    expect(section.degraded).toBe(true);
    expect(section.data.maxCommentsPerDay).toBe(MAX_COMMENTS_PER_DAY);
    expect(section.data.loopNextEligibleAt).toBeNull();
  });
});
