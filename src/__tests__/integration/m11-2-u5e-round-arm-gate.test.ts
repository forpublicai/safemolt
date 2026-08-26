/**
 * M11-2 P3.2 `[integration]` — the playground-round wakeup gate lives IN the statement
 * (codex u5-C round 1 MAJOR).
 *
 * Both wakeup writers used to pre-read the session (active, round matches, agent un-acted) and then
 * await other work before inserting. A session advancing in that window let a stale round-N wakeup
 * land beside the legitimate round-N+1 one — two claimable rows for one agent, double budget the
 * moment P3.3's runner exists, because the event-keyed dedup index sees two event ids.
 *
 * `createOrReArmPlaygroundRoundWakeup` closes it: the freshness check is a `live` CTE taking the
 * session row `FOR SHARE`, so it either sees the advancement's committed round (and arms nothing)
 * or blocks the advancement until the arm commits. The race test below is the DETERMINISTIC form of
 * the finding's interleaving: the pre-read is taken while the round is live, the advancement then
 * commits, and only after that does the arm statement run — the old code inserts here; the gated
 * statement must not.
 *
 * Mutation-checked: with `live`'s round predicate removed (`s.current_round = $8` dropped), the
 * "already advanced" case and the race case both fail by wrongly inserting; restored, all green.
 */
import {
  createOrReArmPlaygroundRoundWakeup,
} from "@/lib/store/wakeups/db";
import { PLAYGROUND_ROUND_REASON } from "@/lib/store/wakeups/db";
import { createPlaygroundSession, getPlaygroundSession } from "@/lib/store/playground/db";
import type { PlaygroundSession } from "@/lib/playground/types";
import { closeIntegrationConnections, pgClient, pgPool } from "./helpers/db";

const RUN = `${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
let seq = 0;
const nextId = (kind: string) => `u5e_${kind}_${RUN}_${(seq += 1)}`;

/** A fresh BIGINT that is not an events row — the queue's `event_id` has no foreign key. */
let syntheticEventId = 910_000_000;
const nextEventId = () => (syntheticEventId += 1);

async function seedAgent(): Promise<string> {
  const id = nextId("agent");
  await pgPool().query(
    `INSERT INTO agents (id, name, description, api_key, points, vote_points, evaluation_points,
                         legacy_unattributed_points, follower_count, is_claimed, created_at, is_vetted)
     VALUES ($1, $1, '', $2, 0, 0, 0, 0, 0, false, NOW(), true)`,
    [id, `u5e_key_${id}`]
  );
  return id;
}

/** One live session per fixture, in a school of its own (`idx_pg_sessions_one_live_per_school`). */
async function seedSession(currentRound: number, status: PlaygroundSession["status"] = "active"): Promise<string> {
  const id = nextId("sess");
  await createPlaygroundSession({
    id,
    gameId: "pub-debate",
    schoolId: `school_${id}`,
    status,
    participants: [],
    currentRound,
    currentRoundPrompt: "act now",
    maxRounds: 6,
    startedAt: status === "active" ? new Date().toISOString() : undefined,
  });
  return id;
}

function gatedInput(agentId: string, sessionId: string, round: number) {
  return {
    agentId,
    eventId: nextEventId(),
    payload: { session_id: sessionId, round },
    delivery: "internal" as const,
    sessionId,
    round,
  };
}

async function wakeupCount(agentId: string): Promise<number> {
  const res = await pgPool().query(
    `SELECT COUNT(*)::int AS n FROM agent_wakeups WHERE agent_id = $1 AND reason = $2`,
    [agentId, PLAYGROUND_ROUND_REASON]
  );
  return (res.rows[0] as { n: number }).n;
}

beforeAll(async () => {
  // Neutralize orphaned LIVE fixture sessions: the one-live-per-school index ignores ids, and an
  // interrupted prior run skips afterAll (the u3d precedent).
  await pgPool().query(
    `UPDATE playground_sessions SET status = 'cancelled', completed_at = NOW()
     WHERE status IN ('pending', 'active')
       AND (id LIKE 'u5e%' OR created_at < NOW() - INTERVAL '1 hour')`
  );
});

afterAll(async () => {
  await pgPool().query(`DELETE FROM agent_wakeups WHERE agent_id LIKE 'u5e_agent_%'`);
  await pgPool().query(`DELETE FROM playground_actions WHERE session_id LIKE 'u5e_sess_%'`);
  await pgPool().query(`DELETE FROM playground_sessions WHERE id LIKE 'u5e_sess_%'`);
  await pgPool().query(`DELETE FROM agents WHERE id LIKE 'u5e_agent_%'`);
  await closeIntegrationConnections();
});

describe("createOrReArmPlaygroundRoundWakeup — the statement-level freshness gate", () => {
  it("creates for a live round the agent has not acted in (control)", async () => {
    const agent = await seedAgent();
    const session = await seedSession(2);

    const result = await createOrReArmPlaygroundRoundWakeup(gatedInput(agent, session, 2));

    expect(result).toEqual({ created: true, reArmed: false });
    expect(await wakeupCount(agent)).toBe(1);
  });

  it("refuses a round the session has ALREADY advanced past, and a session that is not active", async () => {
    const agent = await seedAgent();
    const advanced = await seedSession(3);
    expect(await createOrReArmPlaygroundRoundWakeup(gatedInput(agent, advanced, 2))).toEqual({
      created: false,
      reArmed: false,
    });

    const completed = await seedSession(2, "completed");
    expect(await createOrReArmPlaygroundRoundWakeup(gatedInput(agent, completed, 2))).toEqual({
      created: false,
      reArmed: false,
    });

    expect(await wakeupCount(agent)).toBe(0);
  });

  it("refuses when the agent already acted this round", async () => {
    const agent = await seedAgent();
    const session = await seedSession(2);
    await pgPool().query(
      `INSERT INTO playground_actions (id, session_id, agent_id, round, content) VALUES ($1, $2, $3, 2, 'acted')`,
      [nextId("act"), session, agent]
    );

    expect(await createOrReArmPlaygroundRoundWakeup(gatedInput(agent, session, 2))).toEqual({
      created: false,
      reArmed: false,
    });
    expect(await wakeupCount(agent)).toBe(0);
  });

  it("the codex r1 race, deterministically: a pre-read says fresh, the advancement commits, the gated arm refuses", async () => {
    const agent = await seedAgent();
    const session = await seedSession(1);

    // 1. The pre-read the OLD code trusted: at this instant the round IS live, so the old
    //    check-then-insert path is now committed to inserting a round-1 wakeup.
    const preRead = await getPlaygroundSession(session);
    expect(preRead?.status).toBe("active");
    expect(preRead?.currentRound).toBe(1);

    // 2. The advancement lands on another connection and COMMITS — the window the finding names.
    //    (An uncommitted variant is exercised below; here the commit precedes the arm entirely.)
    const advancer = await pgClient();
    try {
      await advancer.query(
        `UPDATE playground_sessions SET current_round = 2 WHERE id = $1 AND current_round = 1`,
        [session]
      );

      // 3. The arm statement runs AFTER the advancement. The old path inserts here; the gate must not.
      const result = await createOrReArmPlaygroundRoundWakeup(gatedInput(agent, session, 1));
      expect(result).toEqual({ created: false, reArmed: false });
      expect(await wakeupCount(agent)).toBe(0);
    } finally {
      await advancer.end();
    }
  });

  it("an IN-FLIGHT advancement serializes against the arm: FOR SHARE waits, then refuses", async () => {
    const agent = await seedAgent();
    const session = await seedSession(1);

    const advancer = await pgClient();
    try {
      await advancer.query("BEGIN");
      await advancer.query(
        `UPDATE playground_sessions SET current_round = 2 WHERE id = $1 AND current_round = 1`,
        [session]
      );

      // The arm must BLOCK on the advancer's row lock — not read the stale round-1 snapshot.
      let settled = false;
      const armPromise = createOrReArmPlaygroundRoundWakeup(gatedInput(agent, session, 1)).then(
        (r) => {
          settled = true;
          return r;
        }
      );
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(settled).toBe(false); // still waiting at the FOR SHARE

      await advancer.query("COMMIT");
      const result = await armPromise;
      expect(result).toEqual({ created: false, reArmed: false });
      expect(await wakeupCount(agent)).toBe(0);
    } finally {
      await advancer.end();
    }
  });

  it("gates the RE-ARM arm too: a re-armable row stays completed once its round is dead", async () => {
    const agent = await seedAgent();
    const session = await seedSession(1);
    const input = gatedInput(agent, session, 1);

    expect((await createOrReArmPlaygroundRoundWakeup(input)).created).toBe(true);
    await pgPool().query(
      `UPDATE agent_wakeups SET completed_at = NOW(), result = 'error' WHERE agent_id = $1`,
      [agent]
    );
    await pgPool().query(`UPDATE playground_sessions SET current_round = 2 WHERE id = $1`, [session]);

    // Same triple, dead round: neither arm fires and the row stays completed.
    expect(await createOrReArmPlaygroundRoundWakeup(input)).toEqual({ created: false, reArmed: false });
    const afterDead = await pgPool().query(
      `SELECT completed_at FROM agent_wakeups WHERE agent_id = $1`,
      [agent]
    );
    expect(afterDead.rows[0].completed_at).not.toBeNull();

    // Control: restore the round and the SAME call re-arms the row in place.
    await pgPool().query(`UPDATE playground_sessions SET current_round = 1 WHERE id = $1`, [session]);
    expect(await createOrReArmPlaygroundRoundWakeup(input)).toEqual({ created: false, reArmed: true });
    const afterLive = await pgPool().query(
      `SELECT completed_at, claim_token FROM agent_wakeups WHERE agent_id = $1`,
      [agent]
    );
    expect(afterLive.rows[0].completed_at).toBeNull();
    expect(afterLive.rows[0].claim_token).toBeNull();
  });
});
