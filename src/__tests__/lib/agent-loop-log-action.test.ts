/**
 * M11-2 u6 stitch item 3 (e) — `logAction` as a **Tier 1 producer**, asserted on the SHAPE of the one
 * statement it renders.
 *
 * Why a shape test. This statement carries the whole of the chunk's coupling, and every part of it is
 * a property of the rendered SQL:
 *  - the `agent_loop_action_log` INSERT, the `agent_loop.action` event and the transitional activity
 *    projection are ONE statement, so a failure leaves none of the three (the u3b/u4prep2 rule);
 *  - the event is GATED on the insert, so a journal row that never landed emits nothing;
 *  - the projection stamps `source_event_id` from the event arm — an id that exists nowhere outside
 *    this statement, which is exactly why it may not be moved back out into a second statement;
 *  - the payload's `log_id` is filled from `inserted.id` rather than left as the store-assigned
 *    marker, which `payloadId` would dead-letter at consume time.
 *
 * Postgres proves the SQL parses and that the row lands (`m11-2-u6-agent-loop-event.test.ts`); this
 * proves the structure on every `npm test`.
 *
 * @jest-environment node
 */
const captured: Array<{ text: string; params: unknown[] }> = [];

jest.mock("@/lib/db", () => {
  const sql = (first: unknown, ...rest: unknown[]) => {
    if (Array.isArray(first) && "raw" in (first as object)) {
      const strings = first as unknown as TemplateStringsArray;
      captured.push({ text: strings.join("?"), params: rest });
    } else {
      captured.push({ text: String(first), params: (rest[0] as unknown[]) ?? [] });
    }
    return Promise.resolve([]);
  };
  return { sql, hasDatabase: () => true };
});

import { logAction } from "@/lib/agent-loop";
import { STORE_ASSIGNED_PAYLOAD_ID } from "@/lib/events/kinds";

beforeEach(() => {
  captured.length = 0;
});

/** `$n` placeholders are numbered, contiguous from 1, and every one has a value. */
function assertPlaceholdersBind(statement: { text: string; params: unknown[] }): void {
  const referenced = new Set([...statement.text.matchAll(/\$(\d+)/g)].map((match) => Number(match[1])));
  const highest = Math.max(...referenced);
  expect(statement.params).toHaveLength(highest);
  for (let index = 1; index <= highest; index += 1) {
    expect(referenced.has(index)).toBe(true);
  }
}

describe("logAction — the journal insert, its event and its trail projection are ONE statement", () => {
  it("renders exactly one statement holding all three writers", async () => {
    await logAction("agent_1", "create_comment", "post", "post_9", "nice point");

    expect(captured).toHaveLength(1);
    const statement = captured[0];
    expect(statement.text).toContain("WITH inserted AS (");
    expect(statement.text).toContain("INSERT INTO agent_loop_action_log");
    expect(statement.text).toContain("INSERT INTO events");
    expect(statement.text).toContain("INSERT INTO activity_events");
    assertPlaceholdersBind(statement);
  });

  it("gates the event on the journal insert, so a refused insert emits nothing", async () => {
    await logAction("agent_1", "create_post", "post", "post_9");

    const statement = captured[0];
    expect(statement.text).toContain("WHERE EXISTS (SELECT 1 FROM inserted)");
    // The event arm reads the inserted row (its `rowSource`), so it cannot render one event for a
    // statement that inserted nothing.
    expect(statement.text).toContain("FROM inserted");
  });

  it("fills the store-assigned log_id from the inserted row rather than leaving the marker", async () => {
    await logAction("agent_1", "create_comment", "comment", "comment_3", "hello");

    const statement = captured[0];
    expect(statement.text).toContain("'log_id'");
    expect(statement.text).toContain("inserted.id");
    // The marker is what a consumer dead-letters on: the ACTION writes it, and this statement must
    // overwrite it. It may still appear in the bound payload (the merge is right-biased in SQL), but
    // the merge expression above is what decides — so assert the merge, and assert the four other
    // payload fields arrived as bound values.
    expect(statement.params).toEqual(
      expect.arrayContaining([
        "agent_1",
        "create_comment",
        "comment",
        "comment_3",
        "hello",
        expect.stringContaining(STORE_ASSIGNED_PAYLOAD_ID),
      ])
    );
  });

  it("stamps source_event_id into the trail projection from the event arm", async () => {
    await logAction("agent_1", "vote_post", "post", "post_9");

    const statement = captured[0];
    expect(statement.text).toContain("source_event_id");
    expect(statement.text).toContain("(SELECT id FROM ev_0)");
    // The monotonic guard rides along, so a re-consumed older event cannot drag the row backward.
    expect(statement.text).toContain("COALESCE(activity_events.source_event_id, 0) <= EXCLUDED.source_event_id");
  });

  it("reads the journal row from the CTE, never from the table it is inserting into", async () => {
    await logAction("agent_1", "create_comment", "post", "post_9");

    const statement = captured[0];
    // `FROM agent_loop_action_log al` would read the statement's snapshot, which predates the row
    // being inserted beside it — the projection would silently write nothing.
    expect(statement.text).not.toContain("FROM agent_loop_action_log al");
    expect(statement.text).toContain("FROM inserted al");
  });

  it("swallows a failed statement — nothing is written, and the caller is not thrown at", async () => {
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
    jest.isolateModules(() => undefined);
    const db = jest.requireMock("@/lib/db") as { sql: unknown };
    const original = db.sql;
    db.sql = () => Promise.reject(new Error("journal statement down"));
    try {
      // It must NOT throw: `agent-pulse/runner.ts` calls this between the terminal action and
      // `completeWakeup`, so a throw here would strand a claimed wakeup until its lease lapsed.
      await expect(logAction("agent_1", "create_comment")).resolves.toBeUndefined();
      expect(errorSpy).toHaveBeenCalledWith("[agent-loop] failed to log action", expect.any(Error));
    } finally {
      db.sql = original;
      errorSpy.mockRestore();
    }
  });
});

describe("logAction — memory mode", () => {
  it("writes nothing and emits nothing with no database (Decision 4, vacuously)", async () => {
    jest.resetModules();
    jest.doMock("@/lib/db", () => ({ sql: null, hasDatabase: () => false }));
    const { logAction: noDbLogAction } = await import("@/lib/agent-loop");
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(noDbLogAction("agent_1", "create_comment")).resolves.toBeUndefined();

    // `agent_loop_action_log` has no memory twin, so there is no mutation — and therefore no event.
    // An expected no-op must not be logged as a failure, which is what the pre-stitch shape did by
    // letting `sql!` throw into its own catch.
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
    jest.dontMock("@/lib/db");
    jest.resetModules();
  });
});
