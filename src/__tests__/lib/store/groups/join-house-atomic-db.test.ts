/**
 * M9 C1: single-house membership must hold under concurrent joins, and house
 * leave must run the founder lifecycle atomically.
 *
 * The Neon HTTP driver has no session affinity, so the DB-side guarantee is the
 * uniq_group_members_single_house partial unique index plus one non-interactive
 * sql.transaction() batch — never standalone BEGIN/FOR UPDATE/COMMIT statements.
 */

const HOUSE_ROW = {
  id: "gryffindor",
  name: "gryffindor",
  display_name: "Gryffindor",
  description: "",
  type: "house",
  owner_id: "founder-1",
  founder_id: "founder-1",
  points: 0,
  created_at: "2026-01-01T00:00:00.000Z",
};

const AGENT_ROW = {
  id: "agent-1",
  name: "agent-1",
  description: "",
  api_key: "k",
  points: 0,
  follower_count: 0,
  is_claimed: false,
  created_at: "2026-01-01T00:00:00.000Z",
};

type Responder = (text: string) => Promise<unknown[]> | null;

const state: {
  queries: string[];
  responder: Responder;
  transactionBatches: string[][];
} = {
  queries: [],
  responder: () => null,
  transactionBatches: [],
};

jest.mock("@/lib/db", () => {
  const run = (strings: TemplateStringsArray | string) => {
    const text = typeof strings === "string" ? strings : strings.join("?");
    state.queries.push(text);
    const custom = state.responder(text);
    if (custom) return custom;
    if (text.includes("FROM groups WHERE id =")) return Promise.resolve([HOUSE_ROW]);
    if (text.includes("FROM agents WHERE id =")) return Promise.resolve([AGENT_ROW]);
    return Promise.resolve([]);
  };

  const sql = Object.assign(
    (strings: TemplateStringsArray | string) => run(strings),
    {
      transaction: jest.fn(
        (
          build: (
            txn: (strings: TemplateStringsArray, ...params: unknown[]) => { __text: string }
          ) => { __text: string }[]
        ) => {
          const batch = build((strings) => ({ __text: strings.join("?") }));
          state.transactionBatches.push(batch.map((q) => q.__text));
          // [promotion UPDATE, membership DELETE ... RETURNING, dissolve DELETE]
          return Promise.resolve([[], [{ agent_id: "agent-1" }], []]);
        }
      ),
    }
  );

  return { hasDatabase: () => true, sql };
});

jest.mock("@/lib/store/activity/events", () => ({
  recordGroupJoinActivityEvent: jest.fn(() => Promise.resolve()),
}));

jest.mock("@/lib/store/evaluations/db", () => ({
  getPassedEvaluations: jest.fn(() => Promise.resolve([])),
}));

import { joinGroup, leaveGroup } from "@/lib/store/groups/db";

function uniqueViolation(): Error {
  const err = new Error(
    'duplicate key value violates unique constraint "uniq_group_members_single_house"'
  ) as Error & { code: string };
  err.code = "23505";
  return err;
}

function sessionScopedStatements(): string[] {
  return state.queries.filter(
    (q) => /^\s*(BEGIN|COMMIT|ROLLBACK)\s*$/.test(q) || q.includes("FOR UPDATE")
  );
}

beforeEach(() => {
  state.queries.length = 0;
  state.responder = () => null;
  state.transactionBatches.length = 0;
});

describe("joinGroup (house, DB mode)", () => {
  it("joins a house without standalone transaction statements", async () => {
    const result = await joinGroup("agent-1", "gryffindor");

    expect(result).toEqual({ success: true });
    expect(sessionScopedStatements()).toEqual([]);
    const insert = state.queries.find((q) => q.includes("INSERT INTO group_members"));
    expect(insert).toContain("is_house");
  });

  it("rejects when the agent is already in a house", async () => {
    state.responder = (text) =>
      text.includes("is_house") && text.includes("SELECT 1")
        ? Promise.resolve([{ "?column?": 1 }])
        : null;

    const result = await joinGroup("agent-1", "gryffindor");

    expect(result.success).toBe(false);
    expect(result.error).toContain("already in a house");
    expect(state.queries.some((q) => q.includes("INSERT INTO group_members"))).toBe(false);
  });

  it("lets exactly one of two simultaneous house joins succeed", async () => {
    // Both joins pass the friendly pre-check (the race window); the partial
    // unique index then rejects the second INSERT with 23505.
    let firstInsert = true;
    state.responder = (text) => {
      if (text.includes("INSERT INTO group_members")) {
        if (firstInsert) {
          firstInsert = false;
          return Promise.resolve([]);
        }
        return Promise.reject(uniqueViolation());
      }
      return null;
    };

    const [a, b] = await Promise.all([
      joinGroup("agent-1", "gryffindor"),
      joinGroup("agent-1", "slytherin"),
    ]);

    const successes = [a, b].filter((r) => r.success);
    const failures = [a, b].filter((r) => !r.success);
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(failures[0].error).toContain("already in a house");
  });
});

describe("leaveGroup (house, DB mode)", () => {
  it("runs promotion, removal, and dissolution in one transaction batch", async () => {
    state.responder = (text) =>
      text.includes("SELECT 1 FROM group_members")
        ? Promise.resolve([{ "?column?": 1 }])
        : null;

    const result = await leaveGroup("agent-1", "gryffindor");

    expect(result).toEqual({ success: true });
    expect(state.transactionBatches).toHaveLength(1);
    const [batch] = state.transactionBatches;
    expect(batch).toHaveLength(3);
    expect(batch[0]).toContain("SET founder_id");
    expect(batch[1]).toContain("DELETE FROM group_members");
    expect(batch[1]).toContain("RETURNING");
    expect(batch[2]).toContain("DELETE FROM groups");
    expect(sessionScopedStatements()).toEqual([]);
  });

  it("reports house-flavored membership errors", async () => {
    const result = await leaveGroup("agent-1", "gryffindor");

    expect(result.success).toBe(false);
    expect(result.error).toBe("Not a member of this house");
    expect(state.transactionBatches).toHaveLength(0);
  });
});
