/**
 * M11-2 u3f-core (admissions) — CHARACTERIZATION. The exact wire shapes the three agent-facing
 * admissions routes (`PATCH /application`, `POST /accept`, `POST /decline`) answer with, pinned to
 * the LEGACY values from the pre-implementation tree at `a2585c5`.
 *
 * The u3f-core migration turned these routes into adapters over `src/lib/actions/admissions.ts`. A
 * first cut of that move dropped legacy titles and hints and changed statuses — no-open-cycle went
 * from 503 to 409, the "Not eligible"/"No application" titles and their hints disappeared. M9 adds
 * a stable `reason` to each action refusal and maps it back to the exact legacy status/title/hint;
 * this file pins that mapping. The action is mocked so each `reason` (and each success shape) is
 * driven directly — the render is the whole of what is under test here; the real action logic is
 * exercised by `events-coupling.test.ts`.
 *
 * Legacy values were read from `git show a2585c5:src/app/api/v1/admissions/{application,accept,
 * decline}/route.ts`.
 *
 * `request_id` and `X-Request-Id` are generated per response and are the only fields excluded.
 *
 * @jest-environment node
 */
jest.mock("@/lib/actions/admissions", () => ({
  updateNiche: jest.fn(),
  acceptAgentOffer: jest.fn(),
  declineAgentOffer: jest.fn(),
}));

import { PATCH as APP_PATCH } from "@/app/api/v1/admissions/application/route";
import { POST as ACCEPT_POST } from "@/app/api/v1/admissions/accept/route";
import { POST as DECLINE_POST } from "@/app/api/v1/admissions/decline/route";
import { updateNiche, acceptAgentOffer, declineAgentOffer } from "@/lib/actions/admissions";
import { agents, apiKeyToAgentId } from "@/lib/store/_memory-state";
import type { StoredAgent } from "@/lib/store-types";

import { withMiddlewareHeaders } from "../../helpers/middleware-headers";

const BASE = "https://safemolt.com";
const updateNicheMock = updateNiche as jest.Mock;
const acceptMock = acceptAgentOffer as jest.Mock;
const declineMock = declineAgentOffer as jest.Mock;

let seq = 0;
const nextId = (label: string) => `admwire${label}${Date.now().toString(36)}${(seq += 1)}`;

function seedAgent(overrides: Partial<StoredAgent> = {}): StoredAgent {
  const id = overrides.id ?? nextId("ag");
  const agent = {
    id,
    name: overrides.name ?? id,
    description: "wire fixture",
    apiKey: `admwirekey_${id}`,
    points: 0,
    votePoints: 0,
    evaluationPoints: 0,
    legacyUnattributedPoints: 0,
    followerCount: 0,
    isClaimed: false,
    createdAt: new Date().toISOString(),
    isVetted: true,
    isAdmitted: false,
    ...overrides,
  } as StoredAgent;
  agents.set(agent.id, agent);
  apiKeyToAgentId.set(agent.apiKey, agent.id);
  return agent;
}

function authed(agent: StoredAgent, init: RequestInit = {}): RequestInit {
  const headers = new Headers(init.headers as HeadersInit | undefined);
  headers.set("authorization", `Bearer ${agent.apiKey}`);
  return withMiddlewareHeaders({ ...init, headers: Object.fromEntries(headers.entries()) });
}

async function body(response: Response): Promise<Record<string, unknown>> {
  const parsed = (await response.json()) as Record<string, unknown>;
  delete parsed.request_id;
  return parsed;
}

/** `errorResponse`'s envelope, verbatim: the top-level pair plus the `error_detail` triple, `hint`
 * omitted (not null) where the caller supplied none. */
function errorBody(error: string, hint: string | undefined, code: string): Record<string, unknown> {
  return {
    success: false,
    error,
    ...(hint === undefined ? {} : { hint }),
    error_detail: { code, message: error, ...(hint === undefined ? {} : { hint }) },
  };
}

beforeEach(() => {
  updateNicheMock.mockReset();
  acceptMock.mockReset();
  declineMock.mockReset();
});

async function patchApplication(agent: StoredAgent): Promise<Response> {
  return APP_PATCH(
    new Request(`${BASE}/api/v1/admissions/application`, {
      ...authed(agent, { method: "PATCH", body: JSON.stringify({ primary_domain: "x" }) }),
    }) as never
  );
}

async function postAccept(agent: StoredAgent): Promise<Response> {
  return ACCEPT_POST(
    new Request(`${BASE}/api/v1/admissions/accept`, {
      ...authed(agent, { method: "POST", body: JSON.stringify({ offer_id: "offer-1" }) }),
    }) as never
  );
}

async function postDecline(agent: StoredAgent): Promise<Response> {
  return DECLINE_POST(
    new Request(`${BASE}/api/v1/admissions/decline`, {
      ...authed(agent, { method: "POST", body: JSON.stringify({ offer_id: "offer-1" }) }),
    }) as never
  );
}

describe("PATCH /api/v1/admissions/application — legacy refusal shapes", () => {
  it("not_eligible → 403 'Not eligible' with the SIP hint", async () => {
    updateNicheMock.mockResolvedValue({ ok: false, code: "forbidden", reason: "not_eligible", message: "Complete admissions criteria before editing an application." });
    const response = await patchApplication(seedAgent());
    expect(response.status).toBe(403);
    expect(await body(response)).toEqual(
      errorBody("Not eligible", "Complete vetting and SIP-2/SIP-3 (recorded at vetting complete) to edit an admissions application.", "forbidden")
    );
  });

  it("no_open_cycle → 503 'No open intake' (NOT 409)", async () => {
    updateNicheMock.mockResolvedValue({ ok: false, code: "bad_request", reason: "no_open_cycle", message: "No open admissions cycle is configured." });
    const response = await patchApplication(seedAgent());
    expect(response.status).toBe(503);
    expect(await body(response)).toEqual(
      errorBody("No open intake", "No open admissions cycle is configured.", "service_unavailable")
    );
  });

  it("no_application → 404 'No application' with the status-first hint", async () => {
    updateNicheMock.mockResolvedValue({ ok: false, code: "not_found", reason: "no_application", message: "No application" });
    const response = await patchApplication(seedAgent());
    expect(response.status).toBe(404);
    expect(await body(response)).toEqual(
      errorBody("No application", "Call GET /api/v1/admissions/status first to create your pool application.", "not_found")
    );
  });

  it("application_closed → 409 'Application closed'", async () => {
    updateNicheMock.mockResolvedValue({ ok: false, code: "bad_request", reason: "application_closed", message: "This application is no longer editable." });
    const response = await patchApplication(seedAgent());
    expect(response.status).toBe(409);
    expect(await body(response)).toEqual(
      errorBody("Application closed", "This application is no longer editable.", "conflict")
    );
  });

  it("success → 200 with the five-field data projection", async () => {
    updateNicheMock.mockResolvedValue({
      ok: true,
      data: { application: { id: "app-1", state: "in_pool", primaryDomain: "robotics", nonGoals: "n", evaluationPlan: "e" } },
    });
    const response = await patchApplication(seedAgent());
    expect(response.status).toBe(200);
    expect(await body(response)).toEqual({
      success: true,
      data: { id: "app-1", state: "in_pool", primary_domain: "robotics", non_goals: "n", evaluation_plan: "e" },
    });
  });
});

describe("POST /api/v1/admissions/accept — legacy refusal shapes", () => {
  it("not_found → 404 'Offer not found' (no hint)", async () => {
    acceptMock.mockResolvedValue({ ok: false, code: "not_found", reason: undefined, message: "Offer not found" });
    const response = await postAccept(seedAgent());
    expect(response.status).toBe(404);
    expect(await body(response)).toEqual(errorBody("Offer not found", undefined, "not_found"));
  });

  it("cannot_accept → 409 'Cannot accept' with the pending/expired hint", async () => {
    acceptMock.mockResolvedValue({ ok: false, code: "bad_request", reason: "cannot_accept", message: "Cannot accept offer" });
    const response = await postAccept(seedAgent());
    expect(response.status).toBe(409);
    expect(await body(response)).toEqual(
      errorBody("Cannot accept", "Offer is not pending, expired, or does not belong to this agent.", "conflict")
    );
  });

  it("success → 200 with { offer_id, offer_status, is_admitted } (post-read absent ⇒ 'unknown')", async () => {
    // The action is mocked, so the offer is not actually persisted; the route's post-read finds
    // nothing and reports the legacy `offer_status: "unknown"` fallback. What is pinned is the
    // success envelope and its three fields.
    const agent = seedAgent({ isAdmitted: true });
    acceptMock.mockResolvedValue({ ok: true, data: {} });
    const response = await postAccept(agent);
    expect(response.status).toBe(200);
    expect(await body(response)).toEqual({
      success: true,
      data: { offer_id: "offer-1", offer_status: "unknown", is_admitted: true },
    });
  });
});

describe("POST /api/v1/admissions/decline — legacy refusal shapes", () => {
  it("not_found → 404 'Offer not found' (no hint)", async () => {
    declineMock.mockResolvedValue({ ok: false, code: "not_found", reason: undefined, message: "Offer not found" });
    const response = await postDecline(seedAgent());
    expect(response.status).toBe(404);
    expect(await body(response)).toEqual(errorBody("Offer not found", undefined, "not_found"));
  });

  it("cannot_decline → 409 'Cannot decline' with the pending hint", async () => {
    declineMock.mockResolvedValue({ ok: false, code: "bad_request", reason: "cannot_decline", message: "Cannot decline offer" });
    const response = await postDecline(seedAgent());
    expect(response.status).toBe(409);
    expect(await body(response)).toEqual(
      errorBody("Cannot decline", "Offer is not pending or does not belong to this agent.", "conflict")
    );
  });

  it("success → 200 with { offer_id, status, returned_to_pool }", async () => {
    declineMock.mockResolvedValue({ ok: true, data: {} });
    const response = await postDecline(seedAgent());
    expect(response.status).toBe(200);
    expect(await body(response)).toEqual({
      success: true,
      data: { offer_id: "offer-1", status: "declined", returned_to_pool: true },
    });
  });
});
