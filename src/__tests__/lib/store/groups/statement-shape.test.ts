/**
 * M11-2 u3c (P1.3) — the SHAPE of every group statement, with no database.
 *
 * The integration suite proves what these statements *do*; this one proves what they *say*, and it
 * is the half that runs on every `npm test`. Two properties are structural rather than behavioral,
 * and both are one careless edit away from being silently lost:
 *
 *  1. **Which CTE each event is gated on.** `emitEventCtes` renders `WHERE EXISTS (SELECT 1 FROM
 *     <decisive>)`, and the decisive CTE's NAME is a string argument. Renaming the CTE and
 *     forgetting the argument produces SQL that does not parse — but pointing it at a *different*
 *     CTE that happens to exist produces SQL that runs and emits an event for a mutation that did
 *     not happen. Only reading the rendered text can tell those apart.
 *  2. **The locked targets and the conflict clauses.** `FOR KEY SHARE` on the group and the agent is
 *     what turns `group_members`' two foreign keys from a `23503` into a refusal; `ON CONFLICT DO
 *     NOTHING RETURNING` is what makes a duplicate join write nothing. A rewrite that dropped either
 *     would still pass every happy-path test.
 *
 * @jest-environment node
 */
interface SqlCall {
  text: string;
  params: unknown[];
}

jest.mock("@/lib/db", () => {
  const globals = globalThis as typeof globalThis & {
    __groupSqlCalls?: SqlCall[];
    __groupSqlRows?: unknown[][];
  };
  globals.__groupSqlCalls ??= [];
  globals.__groupSqlRows ??= [];
  const sql = jest.fn((query: TemplateStringsArray | string, ...rest: unknown[]) => {
    const text = typeof query === "string" ? query : query.join("?");
    const params = typeof query === "string" ? ((rest[0] as unknown[]) ?? []) : rest;
    globals.__groupSqlCalls!.push({ text, params });
    return Promise.resolve(globals.__groupSqlRows!.shift() ?? []);
  }) as jest.Mock & { transaction: jest.Mock };
  sql.transaction = jest.fn(async (build: (txn: unknown) => unknown[]) =>
    Promise.all(build(sql) as Array<Promise<unknown>>)
  );
  return { hasDatabase: () => true, sql };
});

import type { PreparedEvent } from "@/lib/events/kinds";
import {
  addModerator,
  createGroup,
  joinGroupWithOutcome,
  leaveGroup,
  removeModerator,
  subscribeToGroup,
  unsubscribeFromGroup,
  updateGroupSettings,
} from "@/lib/store/groups/db";

const globals = globalThis as typeof globalThis & {
  __groupSqlCalls: SqlCall[];
  __groupSqlRows: unknown[][];
};

const calls = () => globals.__groupSqlCalls;
/** Queue the rows each successive `sql` call answers with, in order. */
const answers = (...rows: unknown[][]) => globals.__groupSqlRows.push(...rows);

/** The one statement that carries an event insert. There is exactly one per mutation. */
function emittingStatement(): string {
  const emitting = calls().filter((call) => call.text.includes("INSERT INTO events"));
  expect(emitting).toHaveLength(1);
  return emitting[0].text;
}

/** What `WHERE EXISTS (SELECT 1 FROM <name>)` the rendered event insert is gated on. */
function gatedOn(text: string): string | null {
  return /INSERT INTO events[\s\S]*?WHERE EXISTS \(SELECT 1 FROM (\w+)\)/.exec(text)?.[1] ?? null;
}

const event = (kind: PreparedEvent["kind"]): PreparedEvent =>
  ({ kind, actorAgentId: "a1", subjectType: "group", subjectId: "g1", payload: {} }) as PreparedEvent;

const GROUP_ROW = {
  id: "g1",
  name: "g1",
  display_name: "G One",
  description: "",
  owner_id: "owner",
  member_ids: [],
  moderator_ids: [],
  pinned_post_ids: [],
  created_at: "2026-01-01T00:00:00.000Z",
};

beforeEach(() => {
  globals.__groupSqlCalls.length = 0;
  globals.__groupSqlRows.length = 0;
});

describe("createGroup", () => {
  it("gates group.created on the group insert, inside the founder-membership batch", async () => {
    // Two reads for the existence pre-check (by id, then by name), then the batch.
    answers([], [], [GROUP_ROW], []);

    await createGroup("g1", "G One", "", "owner", "foundation", [event("group.created")]);

    const text = emittingStatement();
    expect(text).toContain("INSERT INTO groups");
    expect(gatedOn(text)).toBe("g");
    // The founder membership is a SECOND batch element, so it must not carry the event.
    expect(calls().some((call) => call.text.includes("INSERT INTO group_members"))).toBe(true);
    expect(
      calls().filter((call) => call.text.includes("INSERT INTO group_members") && call.text.includes("INSERT INTO events"))
    ).toHaveLength(0);
  });
});

describe("joinGroup", () => {
  it("locks both parents, conflicts without erroring, and gates the event on the insert", async () => {
    answers([{ group_exists: 1, actor_exists: 1, inserted: 1, group_name: "g1", group_display_name: "G One" }], []);

    await joinGroupWithOutcome("a1", "g1", [event("group.joined")]);

    const text = emittingStatement();
    // The two locked targets `group_members`' foreign keys would otherwise raise 23503 against.
    expect(text).toContain("FROM groups WHERE id = $2::text FOR KEY SHARE");
    expect(text).toContain("FROM agents WHERE id = $1::text FOR KEY SHARE");
    expect(text).toContain("ON CONFLICT (agent_id, group_id) DO NOTHING");
    expect(text).toContain("RETURNING agent_id");
    // Gated on the INSERT, never on the target: a duplicate join must emit nothing.
    expect(gatedOn(text)).toBe("joined");
    // And the statement projects its own classification rather than leaving it to a later read.
    expect(text).toContain("AS group_exists");
    expect(text).toContain("AS actor_exists");
    expect(text).toContain("AS inserted");
  });

  it("emits nothing at all when no event is supplied", async () => {
    answers([{ group_exists: 1, actor_exists: 1, inserted: 1, group_name: "g1" }], []);
    await joinGroupWithOutcome("a1", "g1");
    expect(calls().some((call) => call.text.includes("INSERT INTO events"))).toBe(false);
  });
});

describe("leaveGroup", () => {
  it("gates group.left on the delete's returned row", async () => {
    answers([{ group_exists: 1, removed: 1 }]);
    await leaveGroup("a1", "g1", [event("group.left")]);

    const text = emittingStatement();
    expect(text).toContain("DELETE FROM group_members");
    expect(gatedOn(text)).toBe("removed");
    expect(text).toContain("AS group_exists");
  });
});

describe("subscribeToGroup / unsubscribeFromGroup", () => {
  /**
   * **The concurrency arbiter** (codex round 1, finding 2).
   *
   * `legacy` and `canonical` are sibling data-modifying CTEs, and PostgreSQL leaves their execution
   * order unspecified. With the group row taken only `FOR KEY SHARE` — a mode that does not conflict
   * with itself — two concurrent subscription writes on one group could enter both arms in opposite
   * orders and take the same two row locks the other way round, which is a deadlock rather than a
   * race the driver retries. `FOR NO KEY UPDATE` conflicts with itself, so the SECOND caller waits at
   * the target and finds both arms already applied; and both arms selecting FROM that locked target
   * is what makes the wait cover them rather than only the one that happens to run first.
   */
  it("serializes both arms behind one self-conflicting lock on the group row", async () => {
    for (const [run, statement] of [
      ["subscribe", async () => { answers([{ group_exists: 1 }]); await subscribeToGroup("a1", "g1", [event("group.subscribed")]); }],
      ["unsubscribe", async () => { answers([{ group_exists: 1 }]); await unsubscribeFromGroup("a1", "g1", [event("group.unsubscribed")]); }],
    ] as const) {
      globals.__groupSqlCalls.length = 0;
      await statement();
      const text = emittingStatement();
      // Self-conflicting, so a second caller waits here rather than interleaving the two arms.
      expect(text).toContain("FROM groups WHERE id = $2::text FOR NO KEY UPDATE");
      // Precisely the GROUP row. Subscribe's `actor` CTE keeps `FOR KEY SHARE`, which is the mode
      // its own foreign key takes and must not be strengthened; unsubscribe has no actor at all,
      // because a DELETE needs none.
      expect(text).not.toContain("FROM groups WHERE id = $2::text FOR KEY SHARE");
      if (run === "subscribe") expect(text).toContain("FROM agents WHERE id = $1::text FOR KEY SHARE");
      // BOTH arms hang off that one locked row — the legacy arm too, which is the one that used to
      // reach `groups` directly and therefore outside the target's serialization.
      const legacyArm = /legacy AS \(([\s\S]*?)\n    \),/.exec(text)?.[1] ?? `${run}: legacy arm not found`;
      expect(legacyArm).toContain("target");
      const canonicalArm = /canonical AS \(([\s\S]*?)\n    \),/.exec(text)?.[1] ?? `${run}: canonical arm not found`;
      expect(canonicalArm).toContain("target");
    }
  });

  it("gates both events on the UNION of the legacy and canonical writes", async () => {
    answers([{ group_exists: 1 }]);
    await subscribeToGroup("a1", "g1", [event("group.subscribed")]);
    const subscribe = emittingStatement();
    // Membership and nothing else — the pinned invariant, visible in the statement text.
    expect(subscribe).toContain("UPDATE groups g\n      SET member_ids");
    expect(subscribe).toContain("INSERT INTO group_members");
    expect(subscribe).toContain("SELECT id FROM legacy UNION ALL SELECT agent_id FROM canonical");
    expect(gatedOn(subscribe)).toBe("changed");

    globals.__groupSqlCalls.length = 0;
    answers([{ group_exists: 1 }]);
    await unsubscribeFromGroup("a1", "g1", [event("group.unsubscribed")]);
    const unsubscribe = emittingStatement();
    expect(unsubscribe).toContain("DELETE FROM group_members");
    expect(unsubscribe).toContain("SET member_ids = COALESCE(g.member_ids, '[]'::jsonb) - $1::text");
    expect(gatedOn(unsubscribe)).toBe("changed");
  });
});

describe("updateGroupSettings", () => {
  it("gates group.settings_updated on the UPDATE's returned row, in one tuple write", async () => {
    answers([GROUP_ROW]);
    await updateGroupSettings("g1", { displayName: "New" }, [event("group.settings_updated")]);

    const text = emittingStatement();
    expect(text).toContain("UPDATE groups SET");
    // One statement for every field, so a crash cannot leave half the edit applied.
    expect(calls().filter((call) => call.text.includes("UPDATE groups"))).toHaveLength(1);
    expect(text).toContain("emoji = CASE WHEN $6::boolean THEN $7::text ELSE emoji END");
    expect(gatedOn(text)).toBe("updated");
  });

  it("issues no statement at all — and therefore no event — when no field is supplied", async () => {
    answers([], []);
    await updateGroupSettings("g1", {}, [event("group.settings_updated")]);
    expect(calls().some((call) => call.text.includes("UPDATE groups"))).toBe(false);
    expect(calls().some((call) => call.text.includes("INSERT INTO events"))).toBe(false);
  });

  /**
   * An explicitly `undefined` value is ABSENT (codex round 3, finding 3). Binding it would make the
   * statement write `COALESCE(NULL, display_name)` — which preserves the column — while the event
   * claimed the field had been written.
   */
  it("issues nothing for an update whose only field is explicitly undefined", async () => {
    answers([], []);
    await updateGroupSettings("g1", { displayName: undefined }, [event("group.settings_updated")]);
    expect(calls().some((call) => call.text.includes("UPDATE groups"))).toBe(false);
    expect(calls().some((call) => call.text.includes("INSERT INTO events"))).toBe(false);
  });

  it("binds only the real edit when an undefined field rides along", async () => {
    answers([GROUP_ROW]);
    await updateGroupSettings("g1", { description: "written", displayName: undefined }, [
      event("group.settings_updated"),
    ]);

    const call = calls().find((entry) => entry.text.includes("UPDATE groups"))!;
    // $2 is display_name and $3 is description — the undefined one binds NULL, which `COALESCE`
    // preserves, and the supplied one binds its value.
    expect(call.params.slice(0, 4)).toEqual(["g1", null, "written", null]);
  });
});

describe("addModerator / removeModerator", () => {
  it("gates each event on the array actually changing", async () => {
    // getGroup (by id), then getAgentByName, then the write.
    answers([GROUP_ROW], [{ id: "t1", name: "target" }], []);
    await addModerator("g1", "owner", "target", [event("group.moderator_added")]);

    const added = emittingStatement();
    expect(added).toContain("moderator_ids = COALESCE(moderator_ids, '[]'::jsonb) || to_jsonb($2::text)");
    // The guard is what makes a repeat add write no tuple, which is what the event is gated on.
    expect(added).toContain("NOT (COALESCE(moderator_ids, '[]'::jsonb) @> to_jsonb($2::text))");
    expect(gatedOn(added)).toBe("updated");

    globals.__groupSqlCalls.length = 0;
    answers([GROUP_ROW], [{ id: "t1", name: "target" }], []);
    await removeModerator("g1", "owner", "target", [event("group.moderator_removed")]);

    const removed = emittingStatement();
    expect(removed).toContain("moderator_ids = COALESCE(moderator_ids, '[]'::jsonb) - $2::text");
    expect(removed).toContain("COALESCE(moderator_ids, '[]'::jsonb) @> to_jsonb($2::text)");
    expect(gatedOn(removed)).toBe("updated");
  });

  it("writes nothing when the caller is not the owner", async () => {
    answers([{ ...GROUP_ROW, owner_id: "somebody_else" }], []);
    await expect(addModerator("g1", "owner", "target", [event("group.moderator_added")])).resolves.toBe(false);
    expect(calls().some((call) => call.text.includes("UPDATE groups"))).toBe(false);
    expect(calls().some((call) => call.text.includes("INSERT INTO events"))).toBe(false);
  });
});
