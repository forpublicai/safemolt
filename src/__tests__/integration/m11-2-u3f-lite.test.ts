/**
 * M11-2 u3f-lite (P1.4) `[integration]` — the profile, avatar and context-file statements against a
 * real Postgres.
 *
 * The memory-mode suite proves the branch decisions. Only this one can prove the statements PARSE
 * and that their guarantees are properties of SQL rather than of JavaScript:
 *
 *  - the **profile edit is one conditional statement**, so an edit that moves nothing writes
 *    nothing and emits nothing, and `payload.fields` is the diff the STATEMENT made — aggregated
 *    from its own `moved` CTE, never from the fields the request offered;
 *  - the **metadata merge happens inside that statement**, so a delta cannot revert a concurrent
 *    platform write, and the `LATERAL VALUES` unpivot that builds the diff really executes;
 *  - the **avatar writes are conditional**, so an identical re-upload and a clear of an absent
 *    avatar emit nothing;
 *  - the **context write and delete carry their events in the same statement**, so a failed event
 *    insert rolls the row back with it and a delete that matched nothing emits nothing;
 *  - and a **withdrawn agent's context write raises 23503**, which is the refusal the memory twin
 *    reproduces by hand.
 *
 * Every fixture value is RUN-suffixed under every UNIQUE column: the reserved database persists
 * rows across runs.
 *
 * @jest-environment node
 */
import { clearMyAvatar, setMyAvatar, updateMyProfile } from "@/lib/actions/profile";
import { removeContextFile, writeContextFile } from "@/lib/actions/memory";
import { STORE_ASSIGNED_PAYLOAD_ID } from "@/lib/events/kinds";
import { updateAgentProfile } from "@/lib/store/agents/db";
import { putContextFile } from "@/lib/memory/context-store-db";
import type { StoredAgent, StoredEvent } from "@/lib/store-types";

import { closeIntegrationConnections, pgPool } from "./helpers/db";

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
let seq = 0;
const nextId = (kind: string) => `u3f${kind}${RUN}${(seq += 1)}`;
let baselineEventId = 0;

async function seedAgent(overrides: { description?: string; displayName?: string; metadata?: unknown } = {}): Promise<StoredAgent> {
  const id = nextId("agent");
  await pgPool().query(
    `INSERT INTO agents (id, name, description, display_name, metadata, api_key, points, vote_points,
                         evaluation_points, legacy_unattributed_points, follower_count, is_claimed,
                         created_at, is_vetted)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, 0, 0, 0, 0, 0, false, NOW(), true)`,
    [
      id,
      `${id}named`,
      overrides.description ?? "before",
      overrides.displayName ?? null,
      overrides.metadata === undefined ? null : JSON.stringify(overrides.metadata),
      `u3fkey${id}`,
    ]
  );
  return {
    id,
    name: `${id}named`,
    apiKey: `u3fkey${id}`,
    description: overrides.description ?? "before",
    isVetted: true,
    isAdmitted: true,
  } as StoredAgent;
}

async function agentRow(agentId: string): Promise<{
  description: string;
  display_name: string | null;
  metadata: Record<string, unknown> | null;
  avatar_url: string | null;
}> {
  const { rows } = await pgPool().query(
    `SELECT description, display_name, metadata, avatar_url FROM agents WHERE id = $1`,
    [agentId]
  );
  return rows[0];
}

async function eventsSince(kind?: string): Promise<StoredEvent[]> {
  const { rows } = await pgPool().query(
    kind === undefined
      ? `SELECT id, kind, actor_agent_id, subject_type, subject_id, school_id, payload
           FROM events WHERE id > $1 ORDER BY id`
      : `SELECT id, kind, actor_agent_id, subject_type, subject_id, school_id, payload
           FROM events WHERE id > $1 AND kind = $2 ORDER BY id`,
    kind === undefined ? [baselineEventId] : [baselineEventId, kind]
  );
  return rows.map((row: Record<string, unknown>) => ({
    id: Number(row.id),
    kind: String(row.kind),
    actorAgentId: (row.actor_agent_id as string) ?? null,
    subjectType: (row.subject_type as string) ?? null,
    subjectId: (row.subject_id as string) ?? null,
    secondarySubjectId: null,
    schoolId: (row.school_id as string) ?? null,
    idemKey: null,
    payload: row.payload as Record<string, unknown>,
    createdAt: "",
  }));
}

/** Fail every event insert of one kind, so the mutation's own rollback can be observed. */
async function withEventFailure<T>(kind: string, run: () => Promise<T>): Promise<T> {
  const suffix = `${RUN}_${++seq}`;
  const functionName = `u3f_fail_event_${suffix}`;
  const triggerName = `u3f_fail_event_trigger_${suffix}`;
  await pgPool().query(`
    CREATE OR REPLACE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
      IF NEW.kind = '${kind}' THEN RAISE EXCEPTION 'u3f injected ${kind} failure'; END IF;
      RETURN NEW;
    END; $fn$;
  `);
  await pgPool().query(
    `CREATE TRIGGER ${triggerName} AFTER INSERT ON events FOR EACH ROW EXECUTE FUNCTION ${functionName}()`
  );
  try {
    return await run();
  } finally {
    await pgPool().query(`DROP TRIGGER IF EXISTS ${triggerName} ON events`);
    await pgPool().query(`DROP FUNCTION IF EXISTS ${functionName}()`);
  }
}

beforeEach(async () => {
  const { rows } = await pgPool().query(`SELECT COALESCE(MAX(id), 0)::bigint AS id FROM events`);
  baselineEventId = Number(rows[0].id);
});

afterEach(async () => {
  // A store-assigned marker that survived is a dead-lettered event nobody sees until a consumer
  // refuses it — the same afterEach u3d and u3e run.
  for (const event of await eventsSince()) {
    expect(JSON.stringify(event.payload)).not.toContain(STORE_ASSIGNED_PAYLOAD_ID);
    expect(event.subjectId).not.toBe(STORE_ASSIGNED_PAYLOAD_ID);
  }
});

afterAll(async () => {
  await closeIntegrationConnections();
});

describe("the profile statement executes and couples its event", () => {
  it("moves three columns in one statement and reports the diff it made", async () => {
    const agent = await seedAgent({ description: "before", metadata: { keep: 1 } });

    const result = await updateMyProfile({
      agent,
      description: "after",
      displayName: "  Shown  ",
      metadata: { bio: "hi" },
    });

    expect(result.ok).toBe(true);
    expect(result.ok && result.data.changedFields).toEqual(["description", "display_name", "metadata"]);
    expect(await agentRow(agent.id)).toMatchObject({
      description: "after",
      display_name: "Shown",
      metadata: { keep: 1, bio: "hi" },
    });

    const emitted = await eventsSince("agent.profile_updated");
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      actorAgentId: agent.id,
      subjectType: "agent",
      subjectId: agent.id,
      schoolId: null,
      payload: { fields: ["description", "display_name", "metadata"] },
    });
  });

  it("names ONLY the field the statement moved, not the three the request offered", async () => {
    const agent = await seedAgent({ description: "before", displayName: "Shown", metadata: { a: 1 } });

    // Three fields offered; two already hold the value being written.
    const result = await updateMyProfile({ agent, description: "after", displayName: "Shown", metadata: { a: 1 } });

    expect(result.ok && result.data.changedFields).toEqual(["description"]);
    const emitted = await eventsSince("agent.profile_updated");
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.payload).toEqual({ fields: ["description"] });
  });

  it("writes nothing and emits nothing when nothing would move", async () => {
    const agent = await seedAgent({ description: "same", displayName: "Same", metadata: { a: 1 } });
    const { rows: before } = await pgPool().query(`SELECT xmin::text AS v FROM agents WHERE id = $1`, [agent.id]);

    const result = await updateMyProfile({ agent, description: "same", displayName: "Same", metadata: { a: 1 } });

    expect(result.ok && result.data.changedFields).toEqual([]);
    const { rows: after } = await pgPool().query(`SELECT xmin::text AS v FROM agents WHERE id = $1`, [agent.id]);
    // The row was not even rewritten: the `WHERE` matched nothing.
    expect(after[0].v).toBe(before[0].v);
    expect(await eventsSince()).toEqual([]);
  });

  it("merges the delta inside the statement, so a platform write in between survives", async () => {
    const agent = await seedAgent({ metadata: { ao_fellow: true } });

    await updateMyProfile({ agent, metadata: { bio: "hello" } });

    expect((await agentRow(agent.id)).metadata).toEqual({ ao_fellow: true, bio: "hello" });
  });

  it("rolls the whole edit back when its event cannot be written", async () => {
    const agent = await seedAgent({ description: "before" });

    await withEventFailure("agent.profile_updated", async () => {
      await expect(updateMyProfile({ agent, description: "after" })).rejects.toThrow(/injected/);
    });

    expect((await agentRow(agent.id)).description).toBe("before");
    expect(await eventsSince()).toEqual([]);
  });

  it("answers no row for an agent that does not exist, and emits nothing", async () => {
    const written = await updateAgentProfile(nextId("ghost"), { description: "x" }, []);
    expect(written).toEqual({ agent: null, changedFields: [] });
    expect(await eventsSince()).toEqual([]);
  });
});

describe("the avatar statements are conditional", () => {
  it("emits once for a change and nothing for an identical re-upload or an empty clear", async () => {
    const agent = await seedAgent();

    await setMyAvatar({ agent, avatarUrl: "data:image/png;base64,AAA" });
    expect(await eventsSince("agent.profile_updated")).toHaveLength(1);
    expect((await agentRow(agent.id)).avatar_url).toBe("data:image/png;base64,AAA");

    baselineEventId = Number(
      (await pgPool().query(`SELECT COALESCE(MAX(id), 0)::bigint AS id FROM events`)).rows[0].id
    );
    await setMyAvatar({ agent, avatarUrl: "data:image/png;base64,AAA" });
    expect(await eventsSince()).toEqual([]);

    await clearMyAvatar({ agent });
    const cleared = await eventsSince("agent.profile_updated");
    expect(cleared).toHaveLength(1);
    expect(cleared[0]!.payload).toEqual({ fields: ["avatar"] });
    expect((await agentRow(agent.id)).avatar_url).toBeNull();

    baselineEventId = Number(
      (await pgPool().query(`SELECT COALESCE(MAX(id), 0)::bigint AS id FROM events`)).rows[0].id
    );
    await clearMyAvatar({ agent });
    expect(await eventsSince()).toEqual([]);
  });
});

describe("context files carry their events in the same statement", () => {
  it("emits memory.context_written on the upsert and memory.context_deleted only on a real delete", async () => {
    const agent = await seedAgent();

    await writeContextFile({ agentId: agent.id, path: "notes.md", content: "c" });
    const written = await eventsSince("memory.context_written");
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      actorAgentId: agent.id,
      subjectId: agent.id,
      payload: { file_path: "notes.md", lazy: false },
    });

    // The second write is an UPDATE through the same upsert: still one row, still one event.
    await writeContextFile({ agentId: agent.id, path: "notes.md", content: "c2", lazy: true });
    const rewritten = await eventsSince("memory.context_written");
    expect(rewritten).toHaveLength(2);
    expect(rewritten[1]!.payload).toEqual({ file_path: "notes.md", lazy: true });

    await removeContextFile({ agentId: agent.id, path: "notes.md" });
    expect(await eventsSince("memory.context_deleted")).toHaveLength(1);

    // Deleting it again matches no row: success, and silence.
    baselineEventId = Number(
      (await pgPool().query(`SELECT COALESCE(MAX(id), 0)::bigint AS id FROM events`)).rows[0].id
    );
    const again = await removeContextFile({ agentId: agent.id, path: "notes.md" });
    expect(again.ok).toBe(true);
    expect(await eventsSince()).toEqual([]);
  });

  it("rolls the row back when the context event cannot be written", async () => {
    const agent = await seedAgent();

    await withEventFailure("memory.context_written", async () => {
      await expect(writeContextFile({ agentId: agent.id, path: "unwritten.md", content: "c" })).rejects.toThrow(
        /injected/
      );
    });

    const { rows } = await pgPool().query(
      `SELECT count(*)::int AS c FROM agent_context_files WHERE agent_id = $1 AND path = 'unwritten.md'`,
      [agent.id]
    );
    expect(rows[0].c).toBe(0);
    expect(await eventsSince()).toEqual([]);
  });

  it("refuses a context write for an agent that does not exist, as the memory twin does", async () => {
    await expect(putContextFile(nextId("ghost"), "orphan.md", "c", [])).rejects.toMatchObject({
      code: "23503",
    });
    expect(await eventsSince()).toEqual([]);
  });
});
