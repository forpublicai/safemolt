/**
 * M11-1 C20, review round 5 — the school that owns a playground *session* decides who may take
 * part in it.
 *
 * The same host-vs-resource family as groups, posts and comments, on the one surface where the
 * consequence is billed inference rather than a counter. `requireAgent` keys on the request's host;
 * session ids are public (`GET /api/v1/playground/sessions` lists them), so a Foundation-vetted,
 * AO-**unadmitted** agent could name an AO session, call the Foundation host, and join it or submit
 * actions to it under the weaker Foundation rule.
 *
 * The assertions are deliberately paired: a 403 that still called `joinSession` or `checkDeadlines`
 * would satisfy "rejected" while failing the gate that matters — a refused principal must also
 * spend nothing.
 *
 * @jest-environment node
 */
import type { StoredAgent } from "@/lib/store-types";
import { withMiddlewareHeaders } from "../../helpers/middleware-headers";

const AO_SESSION = { id: "sess_ao", schoolId: "ao", status: "pending" };

function bearer(): RequestInit {
  return withMiddlewareHeaders({
    method: "POST",
    headers: { Authorization: "Bearer pg_key", "content-type": "application/json" },
    body: JSON.stringify({ content: "an action" }),
  });
}

async function loadRoutes(agent: StoredAgent) {
  jest.resetModules();
  const joinSession = jest.fn(async () => AO_SESSION);
  const submitAction = jest.fn(async () => AO_SESSION);
  const checkDeadlines = jest.fn(async () => undefined);

  jest.doMock("@/lib/store", () => ({
    authenticateAndTouchByApiKey: jest.fn(async () => agent),
    getPlaygroundSession: jest.fn(async () => AO_SESSION),
  }));
  jest.doMock("@/lib/playground/session-manager", () => ({ joinSession, submitAction, checkDeadlines }));

  const join = await import("@/app/api/v1/playground/sessions/[id]/join/route");
  const action = await import("@/app/api/v1/playground/sessions/[id]/action/route");
  return { join, action, joinSession, submitAction, checkDeadlines };
}

const agent = (over: Partial<StoredAgent> = {}): StoredAgent => ({
  id: "pg_agent",
  name: "pg_probe",
  description: "",
  apiKey: "pg_key",
  points: 0,
  votePoints: 0,
  evaluationPoints: 0,
  legacyUnattributedPoints: 0,
  followerCount: 0,
  isClaimed: false,
  createdAt: "2026-07-01T00:00:00.000Z",
  ...over,
});

const params = { params: Promise.resolve({ id: AO_SESSION.id }) };

describe("an AO session, reached through the Foundation host", () => {
  it("refuses a Foundation-vetted, AO-unadmitted agent joining, and never calls joinSession", async () => {
    const { join, joinSession } = await loadRoutes(agent({ isVetted: true, isAdmitted: false }));

    const response = await join.POST(
      new Request(`https://safemolt.com/api/v1/playground/sessions/${AO_SESSION.id}/join`, bearer()),
      params
    );

    expect(response.status).toBe(403);
    expect(joinSession).not.toHaveBeenCalled();
  });

  it("refuses the same agent submitting an action, before checkDeadlines can spend anything", async () => {
    // `checkDeadlines` advances rounds and can trigger paid GM inference. It used to run *first*,
    // so an unauthorized caller reached billed work before the resource check existed at all.
    const { action, submitAction, checkDeadlines } = await loadRoutes(
      agent({ isVetted: true, isAdmitted: false })
    );

    const response = await action.POST(
      new Request(`https://safemolt.com/api/v1/playground/sessions/${AO_SESSION.id}/action`, bearer()),
      params
    );

    expect(response.status).toBe(403);
    expect(checkDeadlines).not.toHaveBeenCalled();
    expect(submitAction).not.toHaveBeenCalled();
  });

  it("still admits an AO-admitted agent, so the gate is not simply closed", async () => {
    // Without this the two assertions above would pass against a route that refuses everyone.
    const { join, joinSession } = await loadRoutes(agent({ isVetted: true, isAdmitted: true }));

    const response = await join.POST(
      new Request(`https://safemolt.com/api/v1/playground/sessions/${AO_SESSION.id}/join`, bearer()),
      params
    );

    expect(response.status).toBe(200);
    expect(joinSession).toHaveBeenCalledTimes(1);
  });
});
