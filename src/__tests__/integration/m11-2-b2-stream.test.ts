/**
 * M11b lane S gen-2 (P5.2) `[integration]` — the seq-allocating CTE and the frame CTEs, against a
 * real Postgres, now that `ai/m11-2-handoff/b1-fixes-landed.md` has opened the gated splice.
 *
 * `m11-2-b2-stream-migration.test.ts` already covers the migration and `reconcile-stream-seq.sql`
 * against real rows — not repeated here. This file covers what only the REAL enqueue/insert
 * statements can show: the counter row's lock genuinely serializes concurrent same-agent enqueues,
 * two idle wakeups land distinct seqs, a re-drained notification/school-ingest writes its frame
 * exactly once.
 */
import http, { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  createWebhookDisabledNotificationIdempotent,
} from "@/lib/store/notifications/db";
import { enqueueWakeup } from "@/lib/store/wakeups/db";
import { POST as postSchoolEvent } from "@/app/api/v1/internal/school-events/route";
import { handleStreamRequest } from "@/lib/worker/stream-server";

import { closeIntegrationConnections, pgPool } from "./helpers/db";
import { raceAgainstHeldLock } from "./helpers/concurrency";

const RUN = `${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
let seq = 0;
const nextId = (kind: string) => `b2s_${kind}_${RUN}_${(seq += 1)}`;

async function seedAgent(): Promise<{ id: string; name: string }> {
  const id = nextId("agent");
  await pgPool().query(
    `INSERT INTO agents (id, name, description, api_key, points, vote_points, evaluation_points,
                         legacy_unattributed_points, follower_count, is_claimed, created_at, is_vetted)
     VALUES ($1, $2, '', $3, 0, 0, 0, 0, 0, false, NOW(), true)`,
    [id, `${id}_named`, `key_${id}`]
  );
  return { id, name: `${id}_named` };
}

afterAll(async () => {
  await closeIntegrationConnections();
});

describe("wakeups/db.ts — the seq-allocating CTE (P5.2)", () => {
  it("a held counter-row lock blocks a concurrent same-agent enqueue, which then takes the next seq", async () => {
    const agent = await seedAgent();
    // Seed the counter as the migration's backfill would, so the holder has a row to lock.
    await pgPool().query(
      `INSERT INTO agent_stream_counters (agent_id, last_seq) VALUES ($1, 10)`,
      [agent.id]
    );

    const result = await raceAgainstHeldLock({
      hold: async (holder) => {
        await holder.query(`SELECT last_seq FROM agent_stream_counters WHERE agent_id = $1 FOR UPDATE`, [
          agent.id,
        ]);
      },
      contend: () =>
        enqueueWakeup({
          agentId: agent.id,
          reason: nextId("seqblock"),
          eventId: null,
          payload: {},
          delivery: "internal",
        }),
      contenderMarker: "race:m11-2-stream-seq",
    });

    expect(result.observedBlocked).toBe(true);
    expect(result.result.created).toBe(true);
    expect(result.result.wakeup?.streamSeq).toBe(11);
  });

  it("two idle wakeups for the same agent get distinct seqs", async () => {
    const agent = await seedAgent();
    const a = await enqueueWakeup({
      agentId: agent.id,
      reason: nextId("idle"),
      eventId: null,
      payload: {},
      delivery: "internal",
    });
    const b = await enqueueWakeup({
      agentId: agent.id,
      reason: nextId("idle"),
      eventId: null,
      payload: {},
      delivery: "internal",
    });

    expect(a.wakeup?.streamSeq).not.toBeNull();
    expect(b.wakeup?.streamSeq).not.toBeNull();
    expect(a.wakeup?.streamSeq).not.toBe(b.wakeup?.streamSeq);
  });
});

describe("notifications/db.ts — the frame CTE (P5.2)", () => {
  it("concurrent re-drain of the same notification insert writes exactly one frame", async () => {
    const agent = await seedAgent();
    const dedupKey = `webhook_disabled:${agent.id}:${nextId("evt")}`;
    const input = { dedupKey, agentId: agent.id, createdAt: new Date().toISOString() };

    const [r1, r2] = await Promise.all([
      createWebhookDisabledNotificationIdempotent(input),
      createWebhookDisabledNotificationIdempotent(input),
    ]);
    expect([r1, r2].filter((row) => row !== null)).toHaveLength(1);

    const { rows } = await pgPool().query(`SELECT * FROM stream_frames WHERE frame_key = $1`, [
      `notification:${dedupKey}`,
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].agent_id).toBe(agent.id);
    expect(rows[0].frame).toBe("notification");
  });
});

describe("school-events route — its own firehose frame (P5.2)", () => {
  const ORIGINAL_SECRET = process.env.SCHOOL_EVENT_SECRET;
  const SECRET = `b2s_secret_${RUN}`;

  beforeAll(() => {
    process.env.SCHOOL_EVENT_SECRET = SECRET;
  });

  afterAll(() => {
    if (ORIGINAL_SECRET === undefined) delete process.env.SCHOOL_EVENT_SECRET;
    else process.env.SCHOOL_EVENT_SECRET = ORIGINAL_SECRET;
  });

  function ingestRequest(entityId: string): Request {
    return new Request("https://safemolt.com/api/v1/internal/school-events", {
      method: "POST",
      headers: { Authorization: `Bearer ${SECRET}`, "content-type": "application/json" },
      body: JSON.stringify({
        kind: "school_event",
        entity_id: entityId,
        title: "a school event",
        summary: "fixture summary",
      }),
    });
  }

  it("re-ingesting the same (kind, entity_id) frames the firehose once", async () => {
    const entityId = nextId("school_event");

    const first = await postSchoolEvent(ingestRequest(entityId));
    expect(first.status).toBe(200);
    const second = await postSchoolEvent(ingestRequest(entityId));
    expect(second.status).toBe(200);

    const { rows } = await pgPool().query(
      `SELECT * FROM stream_frames WHERE frame_key = $1`,
      [`activity:firehose:school_event:${entityId}`]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].agent_id).toBeNull();
    expect(rows[0].frame).toBe("activity");
  });
});

describe("stream-server — end-to-end SSE delivery (P5.2, codex b2-s round-1 finding 9, reduced)", () => {
  let server: Server;
  let port: number;

  beforeAll(async () => {
    server = createServer((req, res) => {
      void handleStreamRequest(req, res).then((handled) => {
        if (!handled) {
          res.writeHead(404);
          res.end();
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("a notification written through the real store reaches a live SSE connection within 2s", async () => {
    const agent = await seedAgent();
    const chunks: string[] = [];

    const client = await new Promise<http.ClientRequest>((resolve, reject) => {
      const req = http.request(
        { host: "127.0.0.1", port, path: "/v1/stream", headers: { Authorization: `Bearer key_${agent.id}` } },
        (res) => {
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => chunks.push(chunk));
          resolve(req);
        }
      );
      req.on("error", reject);
      req.end();
    });

    await new Promise((r) => setTimeout(r, 100)); // let the connect-time (live-only) cursor settle

    const dedupKey = `webhook_disabled:${agent.id}:${nextId("evt")}`;
    await createWebhookDisabledNotificationIdempotent({
      dedupKey,
      agentId: agent.id,
      createdAt: new Date().toISOString(),
    });

    await new Promise<void>((resolve, reject) => {
      const start = Date.now();
      const poll = (): void => {
        if (chunks.join("").includes("event: notification")) return resolve();
        if (Date.now() - start > 2_000) return reject(new Error("notification frame did not arrive within 2s"));
        setTimeout(poll, 25);
      };
      poll();
    });

    client.destroy();
    expect(chunks.join("")).toContain("event: notification");
  });
});
