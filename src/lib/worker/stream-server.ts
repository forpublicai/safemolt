import type { IncomingMessage, ServerResponse } from "node:http";
import { hasDatabase, sql } from "@/lib/db";
import { isPubliclyHiddenAgent } from "@/lib/agent-public";
import { authenticateAndTouchByApiKey, getAgentById } from "@/lib/store";
import { activityEvents } from "@/lib/store/_memory-state";
import type { StoredWakeup, StreamFrame } from "@/lib/store/stream";
import { getLatestStreamFrameId, listStreamFramesForTail, listWakeupFramesForReplay } from "@/lib/store/stream";
import { verifyStreamToken } from "@/lib/stream/token";
import type { ShouldStop } from "@/lib/worker/stop-signal";

/**
 * M11b Lane S (P5.2) — the worker's SSE endpoints. `handleStreamRequest` is mounted into
 * `worker/index.ts`'s existing `node:http` server; it returns `false` for any path it does not own
 * so the caller's own 404 fallback still applies. The seq-allocating CTE and the frame-CTE splices
 * have landed (`store/stream/db.ts`, `store/activity/events.ts`), so replay and tail run on real data.
 */

const STREAM_PATH = "/v1/stream";
const FIREHOSE_PATH = "/v1/stream/firehose";

const MAX_CONNECTIONS_PER_AGENT = 2;
const KEEPALIVE_MS = 25_000;
const TAIL_INTERVAL_MS = 1_000;
const OVERLAP_SECONDS = 5;
const REPLAY_LIMIT = 500;
const TAIL_BATCH_LIMIT = 200;
/** How far behind the high-water mark a dedup entry is kept — bounds the overlap re-scan's memory. */
const DEDUP_WINDOW = 2_000;

// --- shutdown signal --------------------------------------------------------------------------

let shutdownSignal: ShouldStop = () => false;

/** Called once at boot by `worker/index.ts` so open connections notice SIGTERM on their next tick. */
export function setStreamShutdownSignal(fn: ShouldStop): void {
  shutdownSignal = fn;
}

// --- connection cap ----------------------------------------------------------------------------
//
// Per-agent only. The public firehose has no agent identity to cap by, and capping it under one
// shared key let two anonymous clients 503 every other one (codex b2-s round-1 finding 3) — see
// `serveFirehose`, which never calls `tryAcquireConnection`.

const connectionCounts = new Map<string, number>();

function tryAcquireConnection(agentId: string): boolean {
  const current = connectionCounts.get(agentId) ?? 0;
  if (current >= MAX_CONNECTIONS_PER_AGENT) return false;
  connectionCounts.set(agentId, current + 1);
  return true;
}

function releaseConnection(agentId: string): void {
  const current = connectionCounts.get(agentId) ?? 0;
  if (current <= 1) connectionCounts.delete(agentId);
  else connectionCounts.set(agentId, current - 1);
}

// --- auth ----------------------------------------------------------------------------------------

/** Only `?token=` may carry auth in the query; a raw key there is rejected outright (plan P5.2). */
function hasRejectedQueryCredential(url: URL): boolean {
  return url.searchParams.has("api_key") || url.searchParams.has("key") || url.searchParams.has("apiKey");
}

function parseBearerApiKey(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) return null;
  const key = header.slice("Bearer ".length).trim();
  return key.length > 0 ? key : null;
}

type AuthResult = { ok: true; agentId: string } | { ok: false; status: number; error: string };

async function resolvePrivateAgentId(req: IncomingMessage, url: URL): Promise<AuthResult> {
  if (hasRejectedQueryCredential(url)) {
    return { ok: false, status: 401, error: "raw api key in the query string is rejected" };
  }
  const bearer = parseBearerApiKey(req);
  if (bearer) {
    // Reuses the existing key-to-agent lookup rather than a dedicated read-only one (none is
    // exported) — this stamps `last_active_at` on a long-lived connection, a minor behavior note.
    const agent = await authenticateAndTouchByApiKey(bearer);
    if (!agent) return { ok: false, status: 401, error: "invalid api key" };
    return { ok: true, agentId: agent.id };
  }
  const token = url.searchParams.get("token");
  if (token) {
    const result = verifyStreamToken(token);
    if (!result.ok) return { ok: false, status: 401, error: result.reason };
    return { ok: true, agentId: result.agentId };
  }
  return { ok: false, status: 401, error: "missing credentials" };
}

// --- frame writers ---------------------------------------------------------------------------

/** Same ids-only allowlist P5.1's webhook payload uses (`webhook-pass.ts`'s `buildSubject`),
 * duplicated locally rather than importing a private helper from another lane's file. */
const SUBJECT_ID_FIELDS = [
  "post_id",
  "comment_id",
  "parent_comment_id",
  "session_id",
  "round",
  "conversation_id",
  "message_id",
  "mentioned_agent_id",
  "source_id",
  "source_type",
  "group_id",
  "agent_id",
] as const;

function buildWakeupSubject(payload: Record<string, unknown>): Record<string, unknown> {
  const subject: Record<string, unknown> = {};
  for (const field of SUBJECT_ID_FIELDS) {
    if (field in payload) subject[field] = payload[field];
  }
  return subject;
}

function buildWakeupStreamPayload(wakeup: StoredWakeup): Record<string, unknown> {
  return {
    reason: wakeup.reason,
    wakeup_id: wakeup.id,
    ...(wakeup.eventId !== null ? { event_id: wakeup.eventId } : {}),
    subject: buildWakeupSubject(wakeup.payload),
    // Decision 8 / P5.3's context contract: the agent's own context endpoint, not the homepage
    // (codex b2-s round-1 finding 8 — "/" sent an external agent to HTML instead of JSON).
    context_href: "/api/v1/agents/me/context",
  };
}

/** Only a `wakeup` frame ever sets `id:` — an id-less frame leaves the client's cursor untouched. */
function writeWakeupFrame(res: ServerResponse, wakeup: StoredWakeup): void {
  if (typeof wakeup.streamSeq !== "number") return;
  const payload = buildWakeupStreamPayload(wakeup);
  res.write(`id: ${wakeup.streamSeq}\nevent: wakeup\ndata: ${JSON.stringify(payload)}\n\n`);
}

function writeLedgerFrame(res: ServerResponse, frame: StreamFrame): void {
  const eventName = frame.frame === "activity" ? "activity" : "notification";
  res.write(`event: ${eventName}\ndata: ${JSON.stringify({ ref_id: frame.refId })}\n\n`);
}

// --- firehose hidden-agent filter --------------------------------------------------------------

/**
 * The frames ledger stores only `ref_id`, never the actor, so a firehose `activity` frame re-reads
 * its source row to check `isPubliclyHiddenAgent` before forwarding it. No store-level getter
 * exists for "one activity row by id" (the activity module is fenced against new exports right
 * now), so this reads `activity_events` directly in db mode and the memory twin's own map in
 * memory mode — both read-only.
 */
async function isFirehoseActorHidden(refId: string): Promise<boolean> {
  const actorId = hasDatabase() ? await lookupActorIdFromDb(refId) : lookupActorIdFromMemory(refId);
  if (!actorId) return false;
  const agent = await getAgentById(actorId);
  return agent ? isPubliclyHiddenAgent(agent) : false;
}

async function lookupActorIdFromDb(refId: string): Promise<string | null> {
  const rows = await sql!(`SELECT actor_id FROM activity_events WHERE id = $1 LIMIT 1`, [refId]);
  const actorId = (rows[0] as { actor_id?: string | null } | undefined)?.actor_id;
  return actorId ?? null;
}

function lookupActorIdFromMemory(refId: string): string | null {
  for (const item of activityEvents.values()) {
    if (item.id === refId) return item.actorId ?? null;
  }
  return null;
}

// --- ledger cursor at connect time ------------------------------------------------------------

// --- per-connection tail state -------------------------------------------------------------------

interface ConnectionState {
  lastWakeupSeq: number;
  lastFrameId: number;
  seenFrameIds: Set<number>;
  /** Wall-clock connect time — bounds the tail query's overlap re-scan (see `sendLedgerFrames`). */
  connectedAtMs: number;
}

function pruneSeenIds(state: ConnectionState): void {
  const floor = state.lastFrameId - DEDUP_WINDOW;
  for (const id of state.seenFrameIds) {
    if (id < floor) state.seenFrameIds.delete(id);
  }
}

async function sendNewWakeups(res: ServerResponse, agentId: string | null, state: ConnectionState): Promise<void> {
  if (!agentId) return; // firehose has no per-recipient wakeups
  const rows = await listWakeupFramesForReplay(agentId, state.lastWakeupSeq, REPLAY_LIMIT);
  for (const wakeup of rows) {
    writeWakeupFrame(res, wakeup);
    if (typeof wakeup.streamSeq === "number") state.lastWakeupSeq = wakeup.streamSeq;
  }
}

/**
 * Every EXAMINED frame advances the cursor and the dedup set before the hidden-actor filter runs
 * (codex b2-s round-1 finding 2). Filtering first left the cursor pinned behind an all-hidden batch
 * forever — 200+ hidden frames meant the next query fetched the exact same 200 again, and a public
 * frame sitting behind them was never reached.
 *
 * `frame.createdAt < state.connectedAtMs` is the OTHER half of finding 4 ("limit the overlap scan
 * to that connection's live window"): the query's own overlap re-scan matches on recency alone, so
 * without this a frame written moments before connect — still inside the `OVERLAP_SECONDS` window —
 * would be fetched and delivered as if it were live. It still counts toward the cursor/dedup update
 * above, so it is never re-examined either.
 */
async function sendLedgerFrames(res: ServerResponse, agentId: string | null, state: ConnectionState): Promise<void> {
  const frames = await listStreamFramesForTail({
    agentId,
    afterId: state.lastFrameId,
    overlapSeconds: OVERLAP_SECONDS,
    limit: TAIL_BATCH_LIMIT,
  });
  for (const frame of frames) {
    if (state.seenFrameIds.has(frame.id)) continue;
    state.seenFrameIds.add(frame.id);
    if (frame.id > state.lastFrameId) state.lastFrameId = frame.id;
    if (Date.parse(frame.createdAt) < state.connectedAtMs) continue;
    if (agentId === null && frame.frame === "activity" && (await isFirehoseActorHidden(frame.refId))) continue;
    writeLedgerFrame(res, frame);
  }
  pruneSeenIds(state);
}

function parseCursor(req: IncomingMessage, url: URL): number {
  const header = req.headers["last-event-id"];
  const raw = Array.isArray(header) ? header[0] : header ?? url.searchParams.get("last_event_id");
  const n = Number(raw ?? "0");
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

// --- connection lifecycle --------------------------------------------------------------------

function writeSseHeaders(res: ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });
  // Node coalesces headers with the first body write and otherwise withholds them — a connection
  // with nothing to replay would sit unflushed until the 25s keep-alive, never confirming "connected".
  res.flushHeaders();
}

/**
 * `releaseKey` is the per-agent slot to free on close, or `null` for the uncapped firehose.
 * `cleanup` is registered on `req`'s `close` event BEFORE any `await` in this function (codex b2-s
 * round-1 finding 5): a client that disconnects while the initial replay is still in flight must
 * still free its slot, even though no timers exist yet — `closed` and the `if (keepAlive)` /
 * `if (tail)` guards make `cleanup` idempotent regardless of how many times or when it runs.
 */
async function replayThenTail(
  req: IncomingMessage,
  res: ServerResponse,
  agentId: string | null,
  cursor: number,
  releaseKey: string | null
): Promise<void> {
  const state: ConnectionState = {
    lastWakeupSeq: cursor,
    lastFrameId: 0,
    seenFrameIds: new Set(),
    connectedAtMs: Date.now(),
  };

  let closed = false;
  let keepAlive: ReturnType<typeof setInterval> | undefined;
  let tail: ReturnType<typeof setInterval> | undefined;
  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    if (keepAlive) clearInterval(keepAlive);
    if (tail) clearInterval(tail);
    if (releaseKey) releaseConnection(releaseKey);
    try {
      res.end();
    } catch {
      // already ended
    }
  };
  req.on("close", cleanup);

  writeSseHeaders(res);

  try {
    // Live-only cursor (finding 4): fixed before the first tail tick can run.
    state.lastFrameId = await getLatestStreamFrameId(agentId);
    await sendNewWakeups(res, agentId, state);
  } catch (error) {
    console.error("[stream] replay failed", error);
  }

  if (closed) return; // the client left during replay; `cleanup` already ran above

  keepAlive = setInterval(() => {
    try {
      res.write(": keep-alive\n\n");
    } catch {
      // connection already gone; the "close" listener above runs the real cleanup
    }
  }, KEEPALIVE_MS);

  // One tick in flight at a time (codex b2-s round-1 finding 7): an overrunning query must not let
  // a second timer start a second query for the same connection, which could deliver an earlier
  // sequence after a later one and move the cursor backward.
  let tickInFlight = false;
  async function tick(): Promise<void> {
    if (closed || shutdownSignal()) {
      cleanup();
      return;
    }
    if (tickInFlight) return;
    tickInFlight = true;
    try {
      await sendNewWakeups(res, agentId, state);
      await sendLedgerFrames(res, agentId, state);
    } catch (error) {
      console.error("[stream] tail tick failed", error);
    } finally {
      tickInFlight = false;
    }
  }

  tail = setInterval(() => {
    void tick();
  }, TAIL_INTERVAL_MS);
}

// --- entry point -------------------------------------------------------------------------------

function writeCors(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Authorization");
}

function writeJsonError(res: ServerResponse, status: number, error: string): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error }));
}

async function serveFirehose(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  // Public, anonymous, uncapped (finding 3) — there is no agent identity here to cap by.
  await replayThenTail(req, res, null, parseCursor(req, url), null);
}

async function servePrivateStream(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const auth = await resolvePrivateAgentId(req, url);
  if (!auth.ok) {
    writeJsonError(res, auth.status, auth.error);
    return;
  }
  if (!tryAcquireConnection(auth.agentId)) {
    writeJsonError(res, 503, "too_many_connections");
    return;
  }
  await replayThenTail(req, res, auth.agentId, parseCursor(req, url), auth.agentId);
}

/**
 * Returns `true` if this request was handled (path matched), `false` otherwise so
 * `worker/index.ts` can fall through to its existing 404.
 */
export async function handleStreamRequest(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://internal");
  if (url.pathname !== STREAM_PATH && url.pathname !== FIREHOSE_PATH) return false;

  writeCors(res);
  if (req.method === "OPTIONS") {
    res.writeHead(204, { "Access-Control-Allow-Methods": "GET, OPTIONS" });
    res.end();
    return true;
  }
  if (req.method !== "GET") {
    writeJsonError(res, 405, "method not allowed");
    return true;
  }

  if (url.pathname === FIREHOSE_PATH) {
    await serveFirehose(req, res, url);
  } else {
    await servePrivateStream(req, res, url);
  }
  return true;
}
