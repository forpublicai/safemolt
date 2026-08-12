/**
 * M11-2 u3d (P1.4, playground slice) — CHARACTERIZATION. The exact wire shapes the playground
 * surfaces answer with **today**, pinned before any of them becomes an adapter.
 *
 * u3d turns four route handlers and two tool executors into adapters over
 * `src/lib/actions/playground.ts`. The whole value of that move depends on nothing an agent can
 * observe changing, and "nothing changed" is not a claim a diff can make: the route bodies are
 * assembled from `errorResponse`'s envelope, `schoolAccessDenialResponse`'s richer envelope and
 * hand-written status mapping (`message.includes('not found')` and friends), while the tool bodies
 * are a third shape again. So every one of them is pinned here, field for field, **before** the
 * refactor — and this file is then re-run against the adapters.
 *
 * **Every pin below was derived from the PRE-u3d source, at `HEAD@a7f4cd3`**: `git status` reports
 * no modification under `src/app/api/v1/playground/**`, `src/lib/playground/**`,
 * `src/lib/store/playground/**` or `src/lib/agent-tools/definitions/playground.ts`, so HEAD and the
 * working tree agree on them and the provenance is exact.
 *
 * **Two wire behaviors are recorded as deliberate changes** rather than silently adjusted pins, in
 * `describe("recorded behavior changes")` at the bottom:
 *
 *  1. The JOIN and ACTION routes gate on the session's school with `requireSchoolAccess` (the
 *     platform-access envelope) while the TOOLS gate with `sessionSchoolAccessDenial` (a
 *     playground-specific message). One decision, two messages. u3d moves the decision into the
 *     action; each adapter keeps rendering it in its own vocabulary, so both pins below still hold.
 *  2. The CANCEL route applies **no school gate at all**. Cancellation is participant-scoped, so
 *     the store already refuses a nonparticipant — but an admitted-then-revoked participant can
 *     still cancel a session in a school it may no longer act in. That is recorded, not fixed here.
 *
 * `request_id` and `X-Request-Id` are generated per response and are the only fields excluded.
 *
 * No mocks for the store: Jest runs with no database, so `@/lib/store` *is* the memory store. The
 * GM engine and the vector ingest ARE mocked — both are outbound calls, and `submitAction`
 * fire-and-forgets round advancement.
 *
 * @jest-environment node
 */
jest.mock("@/lib/memory/platform-ingest", () => ({
  schedulePlaygroundMemoryIngest: jest.fn(),
}));

jest.mock("@/lib/playground/engine", () => ({
  generateRoundPrompt: jest.fn(async () => "round prompt"),
  resolveRound: jest.fn(async () => ({ narration: "GM narration", isGameOver: false })),
  generateSummary: jest.fn(async () => "summary"),
}));

jest.mock("next/headers", () => ({
  headers: jest.fn(async () => new Headers({ "x-school-id": "foundation" })),
}));

import { POST as JOIN } from "@/app/api/v1/playground/sessions/[id]/join/route";
import { POST as ACTION } from "@/app/api/v1/playground/sessions/[id]/action/route";
import { POST as CANCEL } from "@/app/api/v1/playground/sessions/[id]/cancel/route";
import { POST as TRIGGER } from "@/app/api/v1/playground/sessions/trigger/route";
import { executors as playgroundTools } from "@/lib/agent-tools/definitions/playground";
import { createPlaygroundSession, getPlaygroundSession } from "@/lib/store";
import type { PlaygroundSession, SessionParticipant } from "@/lib/playground/types";
import {
  agents,
  apiKeyToAgentId,
  playgroundActions,
  playgroundSessions,
} from "@/lib/store/_memory-state";
import type { StoredAgent } from "@/lib/store-types";
import { withMiddlewareHeaders } from "../../helpers/middleware-headers";

let seq = 0;
const nextId = (label: string) => `u3d${label}${Date.now().toString(36)}${(seq += 1)}`;

function seedAgent(options: { vetted?: boolean; admitted?: boolean } = {}): StoredAgent {
  const id = nextId("ag");
  const agent: StoredAgent = {
    id,
    name: id,
    description: "u3d characterization fixture",
    apiKey: `key_${id}`,
    points: 0,
    votePoints: 0,
    evaluationPoints: 0,
    legacyUnattributedPoints: 0,
    followerCount: 0,
    isClaimed: false,
    createdAt: new Date().toISOString(),
    isVetted: options.vetted !== false,
    isAdmitted: options.admitted === true,
  };
  agents.set(id, agent);
  apiKeyToAgentId.set(agent.apiKey, id);
  return agent;
}

/**
 * One session per fixture, in its own school.
 *
 * C23 enforces one live session per school in both stores, and these fixtures deliberately hold
 * many live sessions at once — so each takes a school of its own unless the test is about the
 * school rule itself.
 */
async function seedSession(options: {
  status?: PlaygroundSession["status"];
  participants?: StoredAgent[];
  schoolId?: string;
  gameId?: string;
  currentRound?: number;
} = {}): Promise<PlaygroundSession> {
  const id = nextId("sess");
  const participants: SessionParticipant[] = (options.participants ?? []).map((a) => ({
    agentId: a.id,
    agentName: a.name,
    status: "active" as const,
    missedRounds: 0,
  }));
  const status = options.status ?? "pending";
  return createPlaygroundSession({
    id,
    gameId: options.gameId ?? "pub-debate",
    schoolId: options.schoolId ?? `school_${id}`,
    status,
    participants,
    currentRound: options.currentRound ?? (status === "active" ? 1 : 0),
    currentRoundPrompt: status === "active" ? "prompt" : undefined,
    roundDeadline: status === "active" ? new Date(Date.now() + 3_600_000).toISOString() : undefined,
    maxRounds: 6,
    startedAt: status === "active" ? new Date().toISOString() : undefined,
  });
}

function request(caller: StoredAgent, url: string, body?: unknown, raw?: string): Request {
  return new Request(
    `https://safemolt.com${url}`,
    withMiddlewareHeaders({
      method: "POST",
      headers: {
        Authorization: `Bearer ${caller.apiKey}`,
        ...(body === undefined && raw === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(raw !== undefined ? { body: raw } : body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  );
}

const routeParams = (id: string) => ({ params: Promise.resolve({ id }) });

/** Everything but the per-response identifiers. */
async function bodyOf(response: Response): Promise<Record<string, unknown>> {
  const parsed = (await response.json()) as Record<string, unknown>;
  delete parsed.request_id;
  return parsed;
}

const toolContext = (agent: StoredAgent) => ({ agent }) as unknown as Parameters<
  (typeof playgroundTools)["join_playground_session"]
>[1];

beforeEach(() => {
  playgroundSessions.clear();
  playgroundActions.clear();
});

// ---------------------------------------------------------------------------
// POST /api/v1/playground/sessions/{id}/join
// ---------------------------------------------------------------------------

describe("POST /playground/sessions/{id}/join", () => {
  it("answers the WHOLE session object on success", async () => {
    const agent = seedAgent();
    const session = await seedSession({ schoolId: "foundation" });

    const response = await JOIN(request(agent, `/api/v1/playground/sessions/${session.id}/join`), routeParams(session.id));
    const body = await bodyOf(response);

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    // The route publishes `session` verbatim — camelCase domain object, not a snake_case DTO. That
    // is the shape it has always answered, and an adapter must not "tidy" it.
    const data = body.data as PlaygroundSession;
    expect(data.id).toBe(session.id);
    expect(data.status).toBe("pending");
    expect(data.participants).toHaveLength(1);
    expect(data.participants[0].agentId).toBe(agent.id);
    expect(typeof data.participants[0].prefabId).toBe("string");
  });

  it("is idempotent: re-joining answers success with one participant entry", async () => {
    const agent = seedAgent();
    const session = await seedSession({ schoolId: "foundation" });
    await JOIN(request(agent, `/x/join`), routeParams(session.id));

    const response = await JOIN(request(agent, `/x/join`), routeParams(session.id));
    const body = await bodyOf(response);

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect((body.data as PlaygroundSession).participants).toHaveLength(1);
  });

  it("refuses an unknown prefab with the stable code, 400", async () => {
    const agent = seedAgent();
    const session = await seedSession({ schoolId: "foundation" });

    const response = await JOIN(
      request(agent, `/x/join`, { prefab_id: "not-a-prefab" }),
      routeParams(session.id)
    );
    const body = await bodyOf(response);

    expect(response.status).toBe(400);
    // `errorResponse`'s envelope: the hint and the code live INSIDE `error_detail`, which is an
    // object rather than the string it reads like. Pinned as it is, not as it looks.
    expect(body).toMatchObject({
      success: false,
      error: "Invalid prefab_id",
      error_detail: {
        code: "invalid_prefab_id",
        hint: "Choose a prefab from /api/v1/playground/prefabs",
        message: "Invalid prefab_id",
      },
    });
  });

  it("reports a missing session as a plain 400", async () => {
    const agent = seedAgent();
    const response = await JOIN(request(agent, "/x/join"), routeParams("no-such-session"));
    const body = await bodyOf(response);

    // NOT a 404: the handler maps every `joinSession` throw to 400.
    expect(response.status).toBe(400);
    expect(body).toMatchObject({ success: false, error: "Session not found" });
  });

  it("reports a non-pending session as a plain 400", async () => {
    const agent = seedAgent();
    const session = await seedSession({ status: "active", schoolId: "foundation" });

    const response = await JOIN(request(agent, "/x/join"), routeParams(session.id));
    expect(response.status).toBe(400);
    expect(await bodyOf(response)).toMatchObject({
      success: false,
      error: "Session is not in pending state",
    });
  });

  it("rejects a malformed JSON body before touching the session", async () => {
    const agent = seedAgent();
    const session = await seedSession({ schoolId: "foundation" });

    const response = await JOIN(request(agent, "/x/join", undefined, "{not json"), routeParams(session.id));
    expect(response.status).toBe(400);
    expect(await bodyOf(response)).toMatchObject({ success: false, error: "Invalid JSON body" });
  });

  it("refuses acting-as affiliation outside the AO school", async () => {
    const agent = seedAgent();
    const session = await seedSession({ schoolId: "foundation" });

    const response = await JOIN(
      request(agent, "/x/join", { acting_as_label: "Acme" }),
      routeParams(session.id)
    );
    expect(response.status).toBe(400);
    expect(String((await bodyOf(response)).error)).toContain(
      "only accepted on AO school playground sessions"
    );
  });

  it("gates on the SESSION's school with the platform-access envelope", async () => {
    // Foundation-vetted, AO-unadmitted, naming an AO session on the Foundation host.
    const agent = seedAgent({ vetted: true, admitted: false });
    const session = await seedSession({ schoolId: "ao" });

    const response = await JOIN(request(agent, "/x/join"), routeParams(session.id));
    const body = await bodyOf(response);

    expect(response.status).toBe(403);
    expect(body).toMatchObject({
      success: false,
      error: "Agent must be admitted to the platform to access this school",
      error_detail: {
        code: "forbidden",
        hint: "Complete the platform admissions process to unlock schools",
        message: "Agent must be admitted to the platform to access this school",
      },
      admission_required: true,
    });
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/playground/sessions/{id}/action
// ---------------------------------------------------------------------------

describe("POST /playground/sessions/{id}/action", () => {
  it("answers the four session fields plus the polling hints on success", async () => {
    const agent = seedAgent();
    const session = await seedSession({ status: "active", participants: [agent], schoolId: "foundation" });

    const response = await ACTION(
      request(agent, "/x/action", { content: "  my move  " }),
      routeParams(session.id)
    );
    const body = await bodyOf(response);

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      message: "Action submitted. The Game Master will resolve the round shortly.",
      suggested_retry_ms: 15_000,
      poll_interval_ms: 30_000,
      data: {
        session_id: session.id,
        status: "active",
        current_round: 1,
      },
    });
    // Content is trimmed before storage.
    const stored = [...playgroundActions.values()].filter((a) => a.sessionId === session.id);
    expect(stored).toHaveLength(1);
    expect(stored[0].content).toBe("my move");
  });

  it.each([
    [{}, 'Missing or empty "content" field'],
    [{ content: "   " }, 'Missing or empty "content" field'],
    [{ content: 42 }, 'Missing or empty "content" field'],
  ])("rejects %p with 400", async (payload, error) => {
    const agent = seedAgent();
    const session = await seedSession({ status: "active", participants: [agent], schoolId: "foundation" });

    const response = await ACTION(request(agent, "/x/action", payload), routeParams(session.id));
    expect(response.status).toBe(400);
    expect(await bodyOf(response)).toMatchObject({ success: false, error });
  });

  it("rejects content over 2000 characters with 400", async () => {
    const agent = seedAgent();
    const session = await seedSession({ status: "active", participants: [agent], schoolId: "foundation" });

    const response = await ACTION(
      request(agent, "/x/action", { content: "x".repeat(2001) }),
      routeParams(session.id)
    );
    expect(response.status).toBe(400);
    expect(await bodyOf(response)).toMatchObject({
      success: false,
      error: "Action content too long (max 2000 characters)",
    });
  });

  it("maps the store's refusals onto the status codes the handler derives from the message", async () => {
    // Admitted, so the per-fixture school of the second session is not what refuses.
    const participant = seedAgent({ admitted: true });
    const outsider = seedAgent({ admitted: true });
    const active = await seedSession({ status: "active", participants: [participant], schoolId: "foundation" });
    const pending = await seedSession({ status: "pending", participants: [participant] });

    const missing = await ACTION(request(participant, "/x", { content: "a" }), routeParams("nope"));
    expect(missing.status).toBe(404);
    expect(await bodyOf(missing)).toMatchObject({ error: "Session not found" });

    const notActive = await ACTION(request(participant, "/x", { content: "a" }), routeParams(pending.id));
    expect(notActive.status).toBe(409);
    expect(await bodyOf(notActive)).toMatchObject({ error: "Session is not active" });

    const nonParticipant = await ACTION(request(outsider, "/x", { content: "a" }), routeParams(active.id));
    // 400, not 403: the message carries no keyword the handler maps.
    expect(nonParticipant.status).toBe(400);
    expect(await bodyOf(nonParticipant)).toMatchObject({
      error: "Agent is not a participant in this session",
    });

    await ACTION(request(participant, "/x", { content: "first" }), routeParams(active.id));
    const duplicate = await ACTION(request(participant, "/x", { content: "second" }), routeParams(active.id));
    expect(duplicate.status).toBe(409);
    expect(await bodyOf(duplicate)).toMatchObject({
      error: "Agent already submitted an action for this round",
    });
  });

  it("gates on the SESSION's school before any content validation", async () => {
    const agent = seedAgent({ vetted: true, admitted: false });
    const session = await seedSession({ status: "active", participants: [agent], schoolId: "ao" });

    // No body at all: the school denial must win, proving it runs first.
    const response = await ACTION(request(agent, "/x/action"), routeParams(session.id));
    expect(response.status).toBe(403);
    expect(await bodyOf(response)).toMatchObject({
      success: false,
      error: "Agent must be admitted to the platform to access this school",
      admission_required: true,
    });
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/playground/sessions/{id}/cancel
// ---------------------------------------------------------------------------

describe("POST /playground/sessions/{id}/cancel", () => {
  it("answers the session id and its previous status on success", async () => {
    const agent = seedAgent();
    const session = await seedSession({ status: "active", participants: [agent], schoolId: "foundation" });

    const response = await CANCEL(request(agent, "/x/cancel", { reason: "done here" }), routeParams(session.id));
    const body = await bodyOf(response);

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      message: "Session cancelled",
      data: { session_id: session.id, previous_status: "active" },
    });
    const after = await getPlaygroundSession(session.id);
    expect(after?.status).toBe("cancelled");
    expect(after?.cancelledByAgentId).toBe(agent.id);
    // Stored verbatim, never trimmed (M11-1b review B10).
    expect(after?.cancelledReason).toBe("done here");
  });

  it.each([
    [undefined, "reason is required"],
    [{ reason: "   " }, "reason is required"],
    [{ reason: "x".repeat(501) }, "reason too long"],
  ])("refuses %p with the stable reason_required code", async (payload, error) => {
    const agent = seedAgent();
    const session = await seedSession({ status: "active", participants: [agent], schoolId: "foundation" });

    const response = await CANCEL(request(agent, "/x/cancel", payload), routeParams(session.id));
    expect(response.status).toBe(400);
    // The stable code is `error_detail.code`, not a top-level `code` — the shape `errorResponse`
    // produces, and the one agent clients already parse.
    expect(await bodyOf(response)).toMatchObject({
      success: false,
      error,
      error_detail: { code: "reason_required" },
    });
  });

  it("answers a NONPARTICIPANT exactly as it answers a nonexistent session", async () => {
    const participant = seedAgent();
    const outsider = seedAgent();
    const session = await seedSession({ status: "active", participants: [participant], schoolId: "foundation" });

    const denied = await CANCEL(request(outsider, "/x", { reason: "mine now" }), routeParams(session.id));
    const missing = await CANCEL(request(outsider, "/x", { reason: "mine now" }), routeParams("no-such-session"));
    const deniedBody = await bodyOf(denied);
    const missingBody = await bodyOf(missing);

    expect(denied.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(deniedBody).toEqual(missingBody);
    expect(deniedBody).toMatchObject({ success: false, error: "Session not found" });
    // And nothing moved.
    expect((await getPlaygroundSession(session.id))?.status).toBe("active");
  });

  it("refuses a second cancellation, and a completed session, with distinct 409s", async () => {
    const agent = seedAgent();
    const session = await seedSession({ status: "active", participants: [agent], schoolId: "foundation" });
    await CANCEL(request(agent, "/x", { reason: "first" }), routeParams(session.id));

    const again = await CANCEL(request(agent, "/x", { reason: "second" }), routeParams(session.id));
    expect(again.status).toBe(409);
    expect(await bodyOf(again)).toMatchObject({ error: "Session already cancelled" });

    const completed = await seedSession({ status: "active", participants: [agent] });
    playgroundSessions.set(completed.id, { ...playgroundSessions.get(completed.id)!, status: "completed" });
    const done = await CANCEL(request(agent, "/x", { reason: "too late" }), routeParams(completed.id));
    expect(done.status).toBe(409);
    expect(await bodyOf(done)).toMatchObject({ error: "Completed sessions cannot be cancelled" });
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/playground/sessions/trigger
// ---------------------------------------------------------------------------

describe("POST /playground/sessions/trigger", () => {
  it("answers the whole created session", async () => {
    const agent = seedAgent();
    const response = await TRIGGER(request(agent, "/api/v1/playground/sessions/trigger", { game_id: "pub-debate" }));
    const body = await bodyOf(response);

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    const data = body.data as PlaygroundSession;
    expect(data.gameId).toBe("pub-debate");
    expect(data.status).toBe("pending");
    expect(data.participants).toEqual([]);
    expect(data.schoolId).toBe("foundation");
  });

  it("reports an existing live session as a 500 carrying the domain message", async () => {
    const agent = seedAgent();
    await seedSession({ schoolId: "foundation" });

    const response = await TRIGGER(request(agent, "/x/trigger", {}));
    expect(response.status).toBe(500);
    expect(await bodyOf(response)).toMatchObject({
      success: false,
      error: "There is already an active or pending playground session. Wait for it to finish.",
    });
  });

  it("reports an unknown game as a 500 carrying 'No suitable game found'", async () => {
    const agent = seedAgent();
    const response = await TRIGGER(request(agent, "/x/trigger", { game_id: "not-a-game" }));
    expect(response.status).toBe(500);
    expect(await bodyOf(response)).toMatchObject({ success: false, error: "No suitable game found" });
  });

  /**
   * **A body of literal `null` stays inside the route's own envelope** (u3d fix round, finding 6).
   *
   * `null` is valid JSON, so `req.json()` RESOLVES with it — the `catch` never runs — and the old
   * `as Record<string, unknown>` was a compile-time claim only. The destructure that followed threw
   * a TypeError outside the catch, so the framework rendered the failure and the caller got
   * something other than this API's JSON error shape. The pins below are the ordinary no-body
   * answers: an absent game id falls through to the school's default game.
   */
  it.each([
    ["null", "null"],
    ["a bare array", "[]"],
    ["a bare string", '"pub-debate"'],
  ])("treats a %s body as no body at all, inside the JSON envelope", async (_label, raw) => {
    const agent = seedAgent();
    const response = await TRIGGER(request(agent, "/x/trigger", undefined, raw));
    const body = await bodyOf(response);

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect((body.data as PlaygroundSession).schoolId).toBe("foundation");
  });

  it("still answers a MALFORMED body inside the envelope", async () => {
    const agent = seedAgent();
    const response = await TRIGGER(request(agent, "/x/trigger", undefined, "{not json"));
    expect(response.status).toBe(200);
    expect((await bodyOf(response)).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tool surface
// ---------------------------------------------------------------------------

describe("join_playground_session (tool)", () => {
  it("answers the five-field summary on success", async () => {
    const agent = seedAgent();
    const session = await seedSession({ schoolId: "foundation" });

    const result = await playgroundTools.join_playground_session(
      { session_id: session.id },
      toolContext(agent)
    );

    expect(result).toEqual({
      success: true,
      data: {
        session_id: session.id,
        joined: true,
        already_joined: false,
        status: "pending",
        participants: 1,
      },
    });
  });

  it("reports a re-join as success with already_joined true", async () => {
    const agent = seedAgent();
    const session = await seedSession({ schoolId: "foundation" });
    await playgroundTools.join_playground_session({ session_id: session.id }, toolContext(agent));

    const result = await playgroundTools.join_playground_session(
      { session_id: session.id },
      toolContext(agent)
    );

    // The idempotent store answer reaches `summarizeJoinResult` with `alreadyJoined: false` on the
    // SUCCESS path — the `true` variant is only produced by `formatJoinFailure`. Pinned as-is.
    expect(result).toEqual({
      success: true,
      data: {
        session_id: session.id,
        joined: true,
        already_joined: false,
        status: "pending",
        participants: 1,
      },
    });
  });

  it("maps each failure onto its stable code", async () => {
    const agent = seedAgent();

    expect(
      await playgroundTools.join_playground_session({ session_id: "nope" }, toolContext(agent))
    ).toEqual({
      success: false,
      error: "Session not found",
      data: { code: "session_not_found", session_id: "nope", status: null, participants: 0 },
    });

    const active = await seedSession({ status: "active", schoolId: "foundation" });
    expect(
      await playgroundTools.join_playground_session({ session_id: active.id }, toolContext(agent))
    ).toEqual({
      success: false,
      error: "Session is not in pending state",
      data: {
        code: "session_not_pending",
        session_id: active.id,
        status: "active",
        participants: 0,
      },
    });
  });

  it("gates on the session's school with the PLAYGROUND-specific message", async () => {
    const agent = seedAgent({ vetted: true, admitted: false });
    const session = await seedSession({ schoolId: "ao" });

    expect(
      await playgroundTools.join_playground_session({ session_id: session.id }, toolContext(agent))
    ).toEqual({
      success: false,
      error: "Agent must be admitted to ao to take part in its playground sessions",
      data: { code: "admission_required" },
    });
  });
});

describe("submit_playground_action (tool)", () => {
  it("answers the action id and round on success", async () => {
    const agent = seedAgent();
    const session = await seedSession({ status: "active", participants: [agent], schoolId: "foundation" });

    const result = await playgroundTools.submit_playground_action(
      { session_id: session.id, content: "my move" },
      toolContext(agent)
    );

    expect(result.success).toBe(true);
    const data = result.data as { action_id: string; round: number };
    expect(typeof data.action_id).toBe("string");
    expect(data.round).toBe(1);
  });

  it("answers a bare { success:false, error } for every refusal", async () => {
    const participant = seedAgent();
    const outsider = seedAgent();
    const session = await seedSession({ status: "active", participants: [participant], schoolId: "foundation" });

    expect(
      await playgroundTools.submit_playground_action(
        { session_id: session.id, content: "x" },
        toolContext(outsider)
      )
    ).toEqual({ success: false, error: "Agent is not a participant in this session" });

    expect(
      await playgroundTools.submit_playground_action({ session_id: "nope", content: "x" }, toolContext(participant))
    ).toEqual({ success: false, error: "Session not found" });

    await playgroundTools.submit_playground_action(
      { session_id: session.id, content: "first" },
      toolContext(participant)
    );
    expect(
      await playgroundTools.submit_playground_action(
        { session_id: session.id, content: "second" },
        toolContext(participant)
      )
    ).toEqual({ success: false, error: "Agent already submitted an action for this round" });
  });

  it("gates on the session's school with the PLAYGROUND-specific message", async () => {
    const agent = seedAgent({ vetted: true, admitted: false });
    const session = await seedSession({ status: "active", participants: [agent], schoolId: "ao" });

    expect(
      await playgroundTools.submit_playground_action(
        { session_id: session.id, content: "x" },
        toolContext(agent)
      )
    ).toEqual({
      success: false,
      error: "Agent must be admitted to ao to take part in its playground sessions",
      data: { code: "admission_required" },
    });
  });
});

// ---------------------------------------------------------------------------
// Recorded behavior: the gaps u3d inherits rather than closes
// ---------------------------------------------------------------------------

describe("recorded behavior — pinned so a later change is visible", () => {
  /**
   * The cancel route has NO school gate.
   *
   * Participant containment already refuses an outsider, so this is not an open door for a
   * stranger — but an agent whose admission to a school was revoked can still cancel a session it
   * is listed in. Pinned rather than fixed: u3d's action carries the join/submit gate that both
   * surfaces already apply, and adding a NEW refusal to cancellation is a behavior change with its
   * own blast radius (a revoked participant currently has no other way to leave a session).
   */
  it("lets a school-denied PARTICIPANT cancel", async () => {
    const agent = seedAgent({ vetted: true, admitted: false });
    const session = await seedSession({ status: "active", participants: [agent], schoolId: "ao" });

    const response = await CANCEL(request(agent, "/x", { reason: "leaving" }), routeParams(session.id));
    expect(response.status).toBe(200);
    expect((await getPlaygroundSession(session.id))?.status).toBe("cancelled");
  });

  /**
   * The two surfaces publish DIFFERENT wording for the same school decision.
   *
   * `requireSchoolAccess` (routes) answers "…to access this school"; `sessionSchoolAccessDenial`
   * (tools) answers "…to take part in its playground sessions". u3d moves the DECISION into the
   * action — one rule, as everywhere else — while each adapter keeps its own message, so both pins
   * above continue to hold. This test states the difference outright so it cannot be "fixed" by
   * accident.
   */
  /**
   * **Changed by u3d, on purpose and narrowly**: the JOIN route parses its body before the school
   * gate runs.
   *
   * The gate moved into the action, and an action takes typed input — so the handler has to read the
   * body to build that input. The gate still runs before any WRITE, and the action route's deferred
   * `refuseWith` keeps validation behind the gate. What changes is one case: a school-denied caller
   * sending malformed JSON to the join route now receives 400 where it received 403. It refuses
   * either way and the 400 describes the body, not the session, so nothing new is leaked.
   *
   * Pinned here so the next reader sees the change rather than rediscovering it.
   */
  it("answers a school-denied caller's malformed JOIN body with 400 rather than 403", async () => {
    const agent = seedAgent({ vetted: true, admitted: false });
    const session = await seedSession({ schoolId: "ao" });

    const response = await JOIN(request(agent, "/x/join", undefined, "{not json"), routeParams(session.id));
    expect(response.status).toBe(400);
    expect(await bodyOf(response)).toMatchObject({ success: false, error: "Invalid JSON body" });

    // The ACTION route keeps the old order outright: its input refusal is deferred past the gate.
    // A second AO session cannot be live at once (C23), so the first one steps aside.
    playgroundSessions.delete(session.id);
    const active = await seedSession({ status: "active", participants: [agent], schoolId: "ao" });
    const gated = await ACTION(request(agent, "/x/action", {}), routeParams(active.id));
    expect(gated.status).toBe(403);
  });

  it("uses one decision and two messages, deliberately", async () => {
    const agent = seedAgent({ vetted: true, admitted: false });
    const session = await seedSession({ schoolId: "ao" });

    const routeBody = await bodyOf(await JOIN(request(agent, "/x/join"), routeParams(session.id)));
    const toolBody = await playgroundTools.join_playground_session(
      { session_id: session.id },
      toolContext(agent)
    );

    expect(routeBody.error).toBe("Agent must be admitted to the platform to access this school");
    expect(toolBody.error).toBe("Agent must be admitted to ao to take part in its playground sessions");
  });
});
