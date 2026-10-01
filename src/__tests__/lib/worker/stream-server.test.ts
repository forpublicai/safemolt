/**
 * M11b Lane S (P5.2) — the worker's SSE endpoints, memory mode (no `POSTGRES_URL`/`DATABASE_URL`).
 *
 * The real enqueue path now assigns `stream_seq` itself; fixtures still stamp it directly onto the
 * memory-mode wakeup row so a test can pick exact, deterministic values regardless of what the
 * per-agent counter would otherwise produce.
 *
 * @jest-environment node
 */
import { createServer, type Server } from "node:http";
import http from "node:http";
import { AddressInfo } from "node:net";
import { createAgent, mergeAgentMetadata, recordStreamFrame } from "@/lib/store";
import { activityEvents, resetStreamFramesState, resetWakeupState, streamFrames, wakeupQueue } from "@/lib/store/_memory-state";
import { enqueueWakeup } from "@/lib/store/wakeups";
import type { StoredWakeup } from "@/lib/store/wakeups/db";
import { handleStreamRequest } from "@/lib/worker/stream-server";
import * as streamStoreForTest from "@/lib/store/stream";
import { mintStreamToken } from "@/lib/stream/token";

/** The mock factory below adds this export; the real module's types do not carry it. */
function setReplayDelayForTest(ms: number): void {
  (streamStoreForTest as unknown as { __setReplayDelayForTest: (ms: number) => void }).__setReplayDelayForTest(ms);
}

// A test-only, on-purpose delay for `listWakeupFramesForReplay` (finding 5's slow-initial-read
// case). Named `__setReplayDelayForTest` and returned from the mock's OWN closure — not an
// outer-scope variable — because Jest's `jest.mock` hoisting forbids referencing one, and the
// exported `pickStore(...)` binding this module re-exports is not `spyOn`-redefinable under this
// project's compiler output.
jest.mock("@/lib/store/stream", () => {
  const actual = jest.requireActual("@/lib/store/stream");
  let delayMs = 0;
  return {
    ...actual,
    __setReplayDelayForTest: (ms: number) => {
      delayMs = ms;
    },
    listWakeupFramesForReplay: async (...args: [string, number, number]) => {
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      return actual.listWakeupFramesForReplay(...args);
    },
  };
});

jest.setTimeout(15_000);

let seq = 0;
const nextName = (label: string) => `stream_${label}_${Date.now().toString(36)}_${(seq += 1)}`;

let server: Server;
let port: number;
const activityKeysToClean: string[] = [];

beforeAll(async () => {
  process.env.STREAM_TOKEN_SECRET = "test-stream-secret";
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

beforeEach(() => {
  resetWakeupState();
  resetStreamFramesState();
});

afterEach(() => {
  for (const key of activityKeysToClean.splice(0)) activityEvents.delete(key);
  for (const req of openClientRequests) req.destroy();
  openClientRequests.clear();
});

// --- fixtures ------------------------------------------------------------------------------------

async function seedAgent(label: string) {
  return createAgent(nextName(label), "stream-server fixture");
}

/** Stamps `streamSeq` directly onto the STORED row (`enqueueWakeup` returns a clone). */
async function seedWakeupWithSeq(agentId: string, streamSeq: number): Promise<StoredWakeup> {
  const result = await enqueueWakeup({
    agentId,
    reason: `stream-fixture-${streamSeq}`,
    eventId: null,
    payload: { post_id: `p${streamSeq}` },
    delivery: "internal",
  });
  if (!result.wakeup) throw new Error("fixture: expected a fresh wakeup row");
  const stored = wakeupQueue.rows.get(result.wakeup.id) as (StoredWakeup & { streamSeq?: number | null }) | undefined;
  if (!stored) throw new Error("fixture: expected the row to be in the queue");
  stored.streamSeq = streamSeq;
  return stored;
}

function seedActivityItem(actorId: string, id: string): void {
  const key = `post:${id}`;
  activityEvents.set(key, {
    id,
    kind: "post",
    occurredAt: new Date().toISOString(),
    actorId,
    title: "fixture",
    summary: "fixture",
    contextHint: "",
    searchText: "",
  });
  activityKeysToClean.push(key);
}

// --- a minimal SSE client --------------------------------------------------------------------

interface SseFrame {
  id: string | null;
  event: string | null;
  data: string;
}

interface SseClient {
  frames: SseFrame[];
  statusCode: number | undefined;
  close: () => void;
  waitFor: (count: number, timeoutMs?: number) => Promise<void>;
}

function parseFrame(block: string): SseFrame {
  let id: string | null = null;
  let event: string | null = null;
  const dataLines: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("id: ")) id = line.slice(4);
    else if (line.startsWith("event: ")) event = line.slice(7);
    else if (line.startsWith("data: ")) dataLines.push(line.slice(6));
  }
  return { id, event, data: dataLines.join("\n") };
}

// Every client socket opened by a test, force-destroyed in `afterEach` — a test that fails before
// its own `close()` must not leak an open SSE connection into the next test or into `afterAll`'s
// `server.close()` (which otherwise waits forever for a socket nothing will ever end).
const openClientRequests = new Set<http.ClientRequest>();
const REQUEST_TIMEOUT_MS = 5_000;

function openSse(path: string, headers: Record<string, string> = {}): Promise<SseClient> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, headers }, (res) => {
      const client: SseClient = {
        frames: [],
        statusCode: res.statusCode,
        close: () => req.destroy(),
        waitFor: (count, timeoutMs = 4_000) =>
          new Promise((waitResolve, waitReject) => {
            const start = Date.now();
            const poll = () => {
              if (client.frames.length >= count) return waitResolve();
              if (Date.now() - start > timeoutMs) return waitReject(new Error(`timed out waiting for ${count} frame(s)`));
              setTimeout(poll, 25);
            };
            poll();
          }),
      };
      let buffer = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        buffer += chunk;
        let sep;
        while ((sep = buffer.indexOf("\n\n")) !== -1) {
          const block = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          if (block.trim().length > 0 && !block.startsWith(":")) client.frames.push(parseFrame(block));
        }
      });
      resolve(client);
    });
    openClientRequests.add(req);
    req.on("error", reject);
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error(`request to ${path} timed out`)));
    req.end();
  });
}

/** For a plain (non-streaming) rejection: the server answers one JSON body and closes. */
function requestJson(path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    openClientRequests.add(req);
    req.on("error", reject);
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error(`request to ${path} timed out`)));
    req.end();
  });
}

// --- tests -----------------------------------------------------------------------------------

describe("stream-server — replay and live tail", () => {
  it("delivers an already-seeded wakeup frame on connect (emit ⇒ frame, well under 2s)", async () => {
    const agent = await seedAgent("emit");
    await seedWakeupWithSeq(agent.id, 1);

    const client = await openSse("/v1/stream", { Authorization: `Bearer ${agent.apiKey}` });
    await client.waitFor(1, 2_000);
    client.close();

    expect(client.frames[0]).toMatchObject({ id: "1", event: "wakeup" });
    const payload = JSON.parse(client.frames[0].data);
    expect(payload.subject).toEqual({ post_id: "p1" });
    // Decision 8 / P5.3's context contract, not the homepage (codex b2-s round-1 finding 8).
    expect(payload.context_href).toBe("/api/v1/agents/me/context");
  });

  it("an id-less notification frame does not corrupt the replay cursor", async () => {
    const agent = await seedAgent("cursor");
    await seedWakeupWithSeq(agent.id, 1);

    const client = await openSse("/v1/stream", { Authorization: `Bearer ${agent.apiKey}` });
    await client.waitFor(1, 2_000);
    expect(client.frames[0]).toMatchObject({ id: "1", event: "wakeup" });

    // Live, between wakeups: the notification lands (and is tailed) BEFORE the second wakeup
    // exists, so the tail tick delivers it on its own — genuinely between the two wakeup frames.
    await recordStreamFrame({ agentId: agent.id, frame: "notification", refId: "n1", frameKey: `n:${agent.id}:1` });
    await client.waitFor(2, 3_000);
    expect(client.frames[1]).toMatchObject({ id: null, event: "notification" });

    await seedWakeupWithSeq(agent.id, 2);
    await client.waitFor(3, 3_000);
    client.close();

    expect(client.frames[2]).toMatchObject({ id: "2", event: "wakeup" });

    // The last REAL id an EventSource client would track is "2" — reconnecting from it must
    // replay nothing, proving the id-less frame in between never touched the cursor.
    const reconnect = await openSse("/v1/stream", {
      Authorization: `Bearer ${agent.apiKey}`,
      "Last-Event-ID": "2",
    });
    await new Promise((r) => setTimeout(r, 300));
    reconnect.close();
    expect(reconnect.frames.filter((f) => f.event === "wakeup")).toHaveLength(0);
  });

  it("keeps a dm wakeup's sender id in the subject, so the recipient knows who wrote", async () => {
    const agent = await seedAgent("dm");
    // The payload `routeDmSent` enqueues for a `dm` wakeup.
    const result = await enqueueWakeup({
      agentId: agent.id,
      reason: "dm",
      eventId: null,
      payload: { conversation_id: "c_1", message_id: "m_1", other_agent_id: "a_sender" },
      delivery: "internal",
    });
    if (!result.wakeup) throw new Error("fixture: expected a fresh wakeup row");
    const stored = wakeupQueue.rows.get(result.wakeup.id) as (StoredWakeup & { streamSeq?: number | null }) | undefined;
    if (!stored) throw new Error("fixture: expected the row to be in the queue");
    stored.streamSeq = 1;

    const client = await openSse("/v1/stream", { Authorization: `Bearer ${agent.apiKey}` });
    await client.waitFor(1, 2_000);
    client.close();

    const payload = JSON.parse(client.frames[0].data);
    expect(payload.subject).toEqual({ conversation_id: "c_1", message_id: "m_1", other_agent_id: "a_sender" });
  });
});

describe("stream-server — auth", () => {
  it("rejects a missing token/key", async () => {
    const result = await requestJson("/v1/stream");
    expect(result.status).toBe(401);
  });

  it("rejects a raw api key passed in the query string", async () => {
    const agent = await seedAgent("rawkey");
    const result = await requestJson(`/v1/stream?api_key=${agent.apiKey}`);
    expect(result.status).toBe(401);
    expect(JSON.parse(result.body).error).toMatch(/query string/);
  });

  it("rejects an expired stream token", async () => {
    const agent = await seedAgent("expired");
    const { token } = mintStreamToken(agent.id, Date.now() - 700_000); // minted 700s in the past, TTL 600s
    const result = await requestJson(`/v1/stream?token=${token}`);
    expect(result.status).toBe(401);
    expect(JSON.parse(result.body).error).toBe("expired");
  });

  it("accepts a valid ?token=", async () => {
    const agent = await seedAgent("validtoken");
    await seedWakeupWithSeq(agent.id, 1);
    const { token } = mintStreamToken(agent.id);
    const client = await openSse(`/v1/stream?token=${token}`);
    await client.waitFor(1, 2_000);
    client.close();
    expect(client.frames[0]).toMatchObject({ id: "1", event: "wakeup" });
  });
});

describe("stream-server — connection cap", () => {
  it("allows 2 concurrent connections per agent and 503s the third", async () => {
    const agent = await seedAgent("cap");
    const a = await openSse("/v1/stream", { Authorization: `Bearer ${agent.apiKey}` });
    const b = await openSse("/v1/stream", { Authorization: `Bearer ${agent.apiKey}` });
    await new Promise((r) => setTimeout(r, 100));
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);

    const third = await requestJson("/v1/stream", { Authorization: `Bearer ${agent.apiKey}` });
    expect(third.status).toBe(503);

    a.close();
    b.close();
  });

  it("frees the slot when the client disconnects mid-replay, before cleanup was ever attached (finding 5)", async () => {
    const agent = await seedAgent("leak");
    // Stands in for a slow read: without finding 5's fix, `req.on("close", ...)` was only attached
    // AFTER this call resolved, so a disconnect during it leaked the connection slot forever.
    setReplayDelayForTest(200);
    try {
      const leaked = await openSse("/v1/stream", { Authorization: `Bearer ${agent.apiKey}` });
      await new Promise((r) => setTimeout(r, 20)); // still inside the delayed read
      leaked.close();
      await new Promise((r) => setTimeout(r, 400)); // let the delayed read resolve and cleanup run
    } finally {
      setReplayDelayForTest(0);
    }

    // Cap is 2: if the first connection's slot leaked, only one of these would succeed.
    const b = await openSse("/v1/stream", { Authorization: `Bearer ${agent.apiKey}` });
    const c = await openSse("/v1/stream", { Authorization: `Bearer ${agent.apiKey}` });
    await new Promise((r) => setTimeout(r, 100));
    expect(b.statusCode).toBe(200);
    expect(c.statusCode).toBe(200);
    b.close();
    c.close();
  });
});

describe("stream-server — firehose", () => {
  it("hides an activity frame whose actor is publicly hidden", async () => {
    const hidden = await seedAgent("firehose_hidden");
    await mergeAgentMetadata(hidden.id, { test: true });
    const visible = await seedAgent("firehose_visible");

    const client = await openSse("/v1/stream/firehose");
    await new Promise((r) => setTimeout(r, 50)); // let the connect-time cursor settle (live-only, finding 4)

    seedActivityItem(hidden.id, "act-hidden-1");
    await recordStreamFrame({ agentId: null, frame: "activity", refId: "act-hidden-1", frameKey: "a:firehose:hidden1" });
    seedActivityItem(visible.id, "act-visible-1");
    await recordStreamFrame({ agentId: null, frame: "activity", refId: "act-visible-1", frameKey: "a:firehose:visible1" });

    await client.waitFor(1, 3_000);
    client.close();

    expect(client.frames).toHaveLength(1);
    expect(JSON.parse(client.frames[0].data)).toEqual({ ref_id: "act-visible-1" });
  });

  it("does not replay a frame written before connect — notifications/firehose are live-only (finding 4)", async () => {
    const visible = await seedAgent("firehose_preconnect");
    seedActivityItem(visible.id, "act-preconnect-1");
    await recordStreamFrame({ agentId: null, frame: "activity", refId: "act-preconnect-1", frameKey: "a:firehose:preconnect1" });

    const client = await openSse("/v1/stream/firehose");
    await new Promise((r) => setTimeout(r, 1_300)); // longer than one tail tick; nothing should ever arrive
    client.close();

    expect(client.frames).toHaveLength(0);
  });

  it("advances past a full batch of hidden frames so a later public one is still reached (finding 2)", async () => {
    const hidden = await seedAgent("firehose_hidden_batch");
    await mergeAgentMetadata(hidden.id, { test: true });
    const visible = await seedAgent("firehose_visible_batch");

    const client = await openSse("/v1/stream/firehose");
    await new Promise((r) => setTimeout(r, 50));

    // 200 == the tail's own per-tick batch limit: all-hidden fills the first tick's whole batch, so
    // only a SECOND tick (cursor correctly advanced past all 200) can reach the frame after them.
    // Backdated past the tail's own 5s overlap re-scan window — an unrelated, pre-existing property
    // of that re-scan (it matches on recency, not on the cursor) would otherwise keep re-admitting
    // these 200 into the id-ordered LIMIT window at tick 2, starving out the genuinely new one. That
    // re-scan is not this fix's target; backdating isolates finding 2's own cursor/dedup behavior.
    for (let i = 0; i < 200; i++) {
      const id = `act-hidden-batch-${i}`;
      const frameKey = `a:firehose:hiddenbatch:${i}`;
      seedActivityItem(hidden.id, id);
      await recordStreamFrame({ agentId: null, frame: "activity", refId: id, frameKey });
      const frameId = streamFrames.byKey.get(frameKey);
      const row = frameId !== undefined ? streamFrames.rows.get(frameId) : undefined;
      if (row) row.createdAt = new Date(Date.now() - 10_000).toISOString();
    }
    seedActivityItem(visible.id, "act-visible-batch");
    await recordStreamFrame({ agentId: null, frame: "activity", refId: "act-visible-batch", frameKey: "a:firehose:visiblebatch" });

    await client.waitFor(1, 5_000);
    client.close();

    expect(client.frames).toHaveLength(1);
    expect(JSON.parse(client.frames[0].data)).toEqual({ ref_id: "act-visible-batch" });
  });

  it("is not capped by the per-agent connection limit — three anonymous clients all connect (finding 3)", async () => {
    const a = await openSse("/v1/stream/firehose");
    const b = await openSse("/v1/stream/firehose");
    const c = await openSse("/v1/stream/firehose");
    await new Promise((r) => setTimeout(r, 100));
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    expect(c.statusCode).toBe(200);
    a.close();
    b.close();
    c.close();
  });
});
