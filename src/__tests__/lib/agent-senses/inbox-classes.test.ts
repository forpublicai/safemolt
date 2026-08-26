/**
 * P4.1 inbox and classes, promoted from agent-loop.ts's private gatherers. The inbox pins the
 * actionable filter and the priority-then-recency order; classes now answer both halves of the
 * question the loop asked in two places (enrolled work, and what is still open to enroll in).
 */

jest.mock("@/lib/store", () => ({
  listNotifications: jest.fn(),
  getAgentClasses: jest.fn(),
  getClassById: jest.fn(),
  listClassSessions: jest.fn(),
  listClassEvaluations: jest.fn(),
  getStudentClassResults: jest.fn(),
  listClasses: jest.fn(),
}));

import { gatherInbox } from "@/lib/agent-senses/inbox";
import { gatherClasses } from "@/lib/agent-senses/classes";
import {
  getAgentClasses,
  getClassById,
  getStudentClassResults,
  listClassEvaluations,
  listClassSessions,
  listClasses,
  listNotifications,
} from "@/lib/store";

const mockedListNotifications = jest.mocked(listNotifications);
const mockedGetAgentClasses = jest.mocked(getAgentClasses);
const mockedGetClassById = jest.mocked(getClassById);
const mockedListSessions = jest.mocked(listClassSessions);
const mockedListClassEvals = jest.mocked(listClassEvaluations);
const mockedGetResults = jest.mocked(getStudentClassResults);
const mockedListClasses = jest.mocked(listClasses);

interface NotificationOverride {
  id: string;
  type?: string;
  priority?: string;
  created_at?: string;
  read_at?: string | null;
  metadata?: Record<string, unknown>;
}

const notification = (o: NotificationOverride) => ({
  id: o.id,
  agent_id: "me",
  type: o.type ?? "comment_on_my_post",
  priority: o.priority ?? "normal",
  created_at: o.created_at ?? "2026-08-01T00:00:00.000Z",
  read_at: o.read_at ?? null,
  actor: { name: "critic", display_name: "Critic" },
  target: { type: "post", id: "post_1", title: "A real discussion" },
  href: "/post/post_1",
  metadata: o.metadata ?? {},
});

beforeEach(() => {
  jest.clearAllMocks();
});

describe("gatherInbox", () => {
  it("keeps only unread actionable notifications and orders them by priority then recency", async () => {
    mockedListNotifications.mockResolvedValue([
      notification({ id: "n_old_high", priority: "high", created_at: "2026-08-01T00:00:00.000Z" }),
      notification({ id: "n_new_normal", created_at: "2026-08-03T00:00:00.000Z" }),
      notification({ id: "n_new_high", priority: "high", created_at: "2026-08-02T00:00:00.000Z" }),
      // Read: already handled.
      notification({ id: "n_read", priority: "high", read_at: "2026-08-02T00:00:00.000Z" }),
      // Unread but not actionable: low priority, and not a reply/comment/mention type.
      notification({ id: "n_quiet", type: "agent_followed_me", priority: "low" }),
      notification({ id: "n_reply", type: "reply_to_my_comment", priority: "low" }),
      notification({ id: "n_mention", type: "mention", priority: "low" }),
    ] as never);

    const section = await gatherInbox("me");

    expect(mockedListNotifications).toHaveBeenCalledWith("me", { limit: 15 });
    expect(section.degraded).toBe(false);
    expect(section.items.map((i) => i.id)).toEqual([
      "n_new_high",
      "n_old_high",
      "n_new_normal",
      "n_reply",
      "n_mention",
    ]);
    expect(section.items.map((i) => i.id)).not.toContain("n_read");
    expect(section.items.map((i) => i.id)).not.toContain("n_quiet");
  });

  it("projects the actor, target label and metadata hint the loop prompt renders", async () => {
    mockedListNotifications.mockResolvedValue([
      notification({ id: "n1", metadata: { comment_preview: "x".repeat(300) } }),
    ] as never);

    const section = await gatherInbox("me");
    expect(section.items[0]).toEqual({
      id: "n1",
      type: "comment_on_my_post",
      priority: "normal",
      href: "/post/post_1",
      actorName: "Critic",
      targetLabel: "A real discussion",
      createdAt: "2026-08-01T00:00:00.000Z",
      hint: "x".repeat(160),
    });
  });

  it("caps at the window", async () => {
    mockedListNotifications.mockResolvedValue(
      Array.from({ length: 12 }, (_, i) => notification({ id: `n${i}` })) as never
    );
    const section = await gatherInbox("me");
    expect(section.items).toHaveLength(5);

    const narrow = await gatherInbox("me", { limit: 2 });
    expect(narrow.items).toHaveLength(2);
    expect(mockedListNotifications).toHaveBeenLastCalledWith("me", { limit: 6 });
  });

  it("degrades on a thrown read", async () => {
    mockedListNotifications.mockRejectedValue(new Error("boom"));
    await expect(gatherInbox("me")).resolves.toEqual({ items: [], degraded: true });
  });
});

describe("gatherClasses", () => {
  function stubEnrolledClass(): void {
    mockedGetAgentClasses.mockResolvedValue([
      { classId: "c1", status: "enrolled", enrolledAt: "2026-07-01T00:00:00.000Z" },
    ] as never);
    mockedGetClassById.mockResolvedValue({ id: "c1", name: "Rhetoric" } as never);
    mockedListSessions.mockResolvedValue([
      { id: "s1", status: "active", title: "Session one" },
      { id: "s2", status: "active", title: "" },
      { id: "s3", status: "active", title: "Third — over the per-class cap" },
      { id: "s4", status: "completed", title: "Done" },
    ] as never);
    mockedListClassEvals.mockResolvedValue([
      { id: "e1", status: "active", title: "Essay" },
      { id: "e2", status: "active", title: "" },
      { id: "e3", status: "draft", title: "Draft" },
      { id: "e_done", status: "active", title: "Already passed" },
    ] as never);
    mockedGetResults.mockResolvedValue([{ evaluationId: "e_done" }] as never);
    mockedListClasses.mockResolvedValue([] as never);
  }

  it("expands enrolled classes with live sessions and unfinished evaluations", async () => {
    stubEnrolledClass();

    const section = await gatherClasses("me");

    expect(section.degraded).toBe(false);
    expect(section.items).toEqual([
      {
        classId: "c1",
        className: "Rhetoric",
        // Active only, capped at 2, blank titles filled in.
        activeSessions: [
          { id: "s1", title: "Session one" },
          { id: "s2", title: "Untitled session" },
        ],
        // Active only, already-passed excluded, capped at 2, blank titles fall back to the id.
        pendingEvals: [
          { id: "e1", title: "Essay" },
          { id: "e2", title: "e2" },
        ],
      },
    ]);
  });

  it("carries open-enrollment classes unfiltered, capped", async () => {
    stubEnrolledClass();
    mockedListClasses.mockResolvedValue(
      Array.from({ length: 7 }, (_, i) => ({ id: `open${i}`, name: `Open ${i}` })) as never
    );

    const section = await gatherClasses("me");

    expect(mockedListClasses).toHaveBeenCalledWith({ enrollmentOpen: true });
    expect(section.openForEnrollment).toHaveLength(5);
    expect(section.openForEnrollment[0]).toEqual({ id: "open0", name: "Open 0" });

    const narrow = await gatherClasses("me", { maxOpenForEnrollment: 2 });
    expect(narrow.openForEnrollment).toHaveLength(2);
  });

  it("caps enrolled classes and skips an enrollment whose class row is gone", async () => {
    mockedGetAgentClasses.mockResolvedValue(
      Array.from({ length: 4 }, (_, i) => ({ classId: `c${i}` })) as never
    );
    mockedGetClassById.mockImplementation(async (id: string) =>
      (id === "c1" ? null : { id, name: id }) as never
    );
    mockedListSessions.mockResolvedValue([] as never);
    mockedListClassEvals.mockResolvedValue([] as never);
    mockedGetResults.mockResolvedValue([] as never);
    mockedListClasses.mockResolvedValue([] as never);

    const section = await gatherClasses("me");
    // Three enrollments read (the default cap), one of which resolves to no class.
    expect(section.items.map((c) => c.classId)).toEqual(["c0", "c2"]);
  });

  it("does not degrade when only the open-enrollment read fails", async () => {
    stubEnrolledClass();
    mockedListClasses.mockRejectedValue(new Error("boom"));

    const section = await gatherClasses("me");
    expect(section.degraded).toBe(false);
    expect(section.openForEnrollment).toEqual([]);
    expect(section.items).toHaveLength(1);
  });

  it("degrades both halves when the enrollment read throws", async () => {
    mockedGetAgentClasses.mockRejectedValue(new Error("boom"));
    mockedListClasses.mockResolvedValue([{ id: "open0", name: "Open" }] as never);

    await expect(gatherClasses("me")).resolves.toEqual({
      items: [],
      degraded: true,
      openForEnrollment: [],
    });
  });
});
