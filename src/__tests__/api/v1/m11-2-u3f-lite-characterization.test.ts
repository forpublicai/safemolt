/**
 * M11-2 u3f-lite (P1.4) — CHARACTERIZATION. The exact wire shapes the profile, avatar, inbox
 * read-state, memory and vetting-challenge surfaces answer with **today**, pinned before any of
 * them becomes an adapter.
 *
 * u3f-lite turns nine route handlers and three tool executors into adapters over
 * `src/lib/actions/profile.ts`, `src/lib/actions/inbox.ts`, `src/lib/actions/memory.ts` and one
 * Tier-B addition to `src/lib/actions/agents.ts`. The whole value of that move depends on nothing
 * an agent can observe changing, and "nothing changed" is not a claim a diff can make: these
 * bodies are assembled from `errorResponse`'s envelope, `memoryAuthError`'s three fixed responses,
 * a hand-written legacy-alias envelope (`fileEnvelope`, which repeats three fields at the top
 * level) and the tools' third shape again. So each of them is pinned here, field for field,
 * **before** the refactor, and this file is then re-run against the adapters.
 *
 * **Every pin below was derived from the PRE-u3f source, at `HEAD@a2585c5`**: `git status` reports
 * no modification under `src/app/api/v1/agents/me/**`, `src/app/api/v1/memory/**`,
 * `src/app/api/v1/agents/vetting/challenge/**`, `src/lib/memory/**` or
 * `src/lib/agent-tools/definitions/{agents,memory}.ts`, so HEAD and the working tree agree on them
 * and the provenance is exact.
 *
 * `request_id` and `X-Request-Id` are generated per response and are the only fields excluded.
 *
 * No mocks for the store: Jest runs with no database, so `@/lib/store` *is* the memory store, and
 * `@/lib/memory/context-store` *is* its in-process map. `@/auth` is mocked because
 * `resolveAgentMemoryAuth` consults the Cognito session on every request whose bearer token misses.
 *
 * @jest-environment node
 */
jest.mock("@/auth", () => ({ auth: jest.fn(async () => null) }));

import { GET as ME_GET, PATCH as ME_PATCH } from "@/app/api/v1/agents/me/route";
import { POST as AVATAR_PUT, DELETE as AVATAR_DELETE } from "@/app/api/v1/agents/me/avatar/route";
import { POST as INBOX_READ } from "@/app/api/v1/agents/me/inbox/[notification_id]/read/route";
import { POST as INBOX_READ_ALL } from "@/app/api/v1/agents/me/inbox/read-all/route";
import {
  GET as CONTEXT_GET,
  PUT as CONTEXT_PUT,
  DELETE as CONTEXT_DELETE,
} from "@/app/api/v1/memory/context/file/route";
import { POST as VECTOR_UPSERT } from "@/app/api/v1/memory/vector/upsert/route";
import { POST as VECTOR_DELETE } from "@/app/api/v1/memory/vector/delete/route";
import { GET as VETTING_CHALLENGE } from "@/app/api/v1/agents/vetting/challenge/[id]/route";
import { GET as EVAL_CHALLENGE } from "@/app/api/v1/evaluations/[id]/challenge/[challengeId]/route";
import { executors as agentTools } from "@/lib/agent-tools/definitions/agents";
import { executors as memoryTools } from "@/lib/agent-tools/definitions/memory";
import * as contextStore from "@/lib/memory/context-store";
import { agents, apiKeyToAgentId, notifications, vettingChallenges } from "@/lib/store/_memory-state";
import type { StoredAgent, StoredNotification, VettingChallenge } from "@/lib/store-types";

import { withMiddlewareHeaders } from "../../helpers/middleware-headers";

const BASE = "https://safemolt.com";

let seq = 0;
const nextId = (label: string) => `u3f${label}${Date.now().toString(36)}${(seq += 1)}`;

function seedAgent(overrides: Partial<StoredAgent> = {}): StoredAgent {
  const id = overrides.id ?? nextId("ag");
  const agent: StoredAgent = {
    id,
    name: overrides.name ?? id,
    description: "u3f characterization fixture",
    apiKey: `key_${id}`,
    points: 0,
    votePoints: 0,
    evaluationPoints: 0,
    legacyUnattributedPoints: 0,
    followerCount: 0,
    isClaimed: false,
    createdAt: new Date().toISOString(),
    isVetted: true,
    isAdmitted: true,
    ...overrides,
  };
  agents.set(agent.id, agent);
  apiKeyToAgentId.set(agent.apiKey, agent.id);
  return agent;
}

function seedNotification(agentId: string, overrides: Partial<StoredNotification> = {}): StoredNotification {
  const row: StoredNotification = {
    id: overrides.id ?? nextId("nt"),
    agent_id: agentId,
    type: "comment_on_my_post",
    priority: "normal",
    created_at: new Date().toISOString(),
    read_at: null,
    actor: { id: "someone", name: "someone", display_name: null, avatar_url: null },
    target: { type: "post", id: "p1", title: "t" },
    href: "/post/p1",
    metadata: {},
    ...overrides,
  } as StoredNotification;
  notifications.set(row.id, row);
  return row;
}

function seedChallenge(agentId: string, overrides: Partial<VettingChallenge> = {}): VettingChallenge {
  const challenge: VettingChallenge = {
    id: overrides.id ?? nextId("vc"),
    agentId,
    values: [3, 1, 2],
    nonce: "nonce-fixture",
    expectedHash: "hash-fixture",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    fetched: false,
    consumed: false,
    ...overrides,
  };
  vettingChallenges.set(challenge.id, challenge);
  return challenge;
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

/**
 * `errorResponse`'s envelope, verbatim: the top-level pair plus the `error_detail` triple, with
 * `hint` omitted (not null) wherever the caller supplied none — `Response.json` drops `undefined`.
 */
function errorBody(
  error: string,
  hint: string | undefined,
  code: string,
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    success: false,
    error,
    ...(hint === undefined ? {} : { hint }),
    error_detail: { code, message: error, ...(hint === undefined ? {} : { hint }) },
    ...extra,
  };
}

const toolContext = (agent: StoredAgent) => ({ agent }) as never;

beforeEach(() => {
  seq += 1;
});

// ---------------------------------------------------------------------------
// PATCH /api/v1/agents/me
// ---------------------------------------------------------------------------

describe("PATCH /api/v1/agents/me", () => {
  it("returns the ten-field profile projection after a description + display_name edit", async () => {
    const agent = seedAgent({ description: "before" });
    const response = await ME_PATCH(
      new Request(`${BASE}/api/v1/agents/me`, {
        ...authed(agent, { method: "PATCH", body: JSON.stringify({ description: " after ", display_name: " Shown " }) }),
      }) as never
    );
    expect(response.status).toBe(200);
    expect(await body(response)).toEqual({
      success: true,
      data: {
        id: agent.id,
        name: agent.name,
        display_name: "Shown",
        description: "after",
        points: 0,
        follower_count: 0,
        is_claimed: false,
        created_at: agent.createdAt,
        metadata: null,
        emoji: null,
      },
    });
    expect(agents.get(agent.id)!.description).toBe("after");
    expect(agents.get(agent.id)!.displayName).toBe("Shown");
  });

  it("merges a metadata delta and reports the merged object plus the emoji projection", async () => {
    const agent = seedAgent({ metadata: { keep: "kept" } });
    const response = await ME_PATCH(
      new Request(`${BASE}/api/v1/agents/me`, {
        ...authed(agent, { method: "PATCH", body: JSON.stringify({ metadata: { website: "https://x.example" }, emoji: " 🦀 " }) }),
      }) as never
    );
    expect(response.status).toBe(200);
    const parsed = (await body(response)).data as Record<string, unknown>;
    expect(parsed.metadata).toEqual({ keep: "kept", website: "https://x.example", emoji: "🦀" });
    expect(parsed.emoji).toBe("🦀");
  });

  it("clears the emoji with an empty string, writing metadata.emoji = null", async () => {
    const agent = seedAgent({ metadata: { emoji: "🦀" } });
    const response = await ME_PATCH(
      new Request(`${BASE}/api/v1/agents/me`, {
        ...authed(agent, { method: "PATCH", body: JSON.stringify({ emoji: "" }) }),
      }) as never
    );
    expect(response.status).toBe(200);
    expect(agents.get(agent.id)!.metadata).toEqual({ emoji: null });
  });

  it("rejects a reserved metadata key by name, 400 reserved_metadata_key, writing nothing", async () => {
    const agent = seedAgent({ metadata: { ao_fellow: true } });
    const response = await ME_PATCH(
      new Request(`${BASE}/api/v1/agents/me`, {
        ...authed(agent, {
          method: "PATCH",
          body: JSON.stringify({ description: "moved?", metadata: { ao_fellow: false, system: true } }),
        }),
      }) as never
    );
    expect(response.status).toBe(400);
    expect(await body(response)).toEqual(errorBody("Reserved metadata keys", "These keys are written by the platform and cannot be set: ao_fellow, system", "reserved_metadata_key", { reserved_keys: ["ao_fellow", "system"] }));
    // The refusal is total: the description edit in the same body is not applied either.
    expect(agents.get(agent.id)!.description).toBe("u3f characterization fixture");
    expect(agents.get(agent.id)!.metadata).toEqual({ ao_fellow: true });
  });

  it("rejects a non-object metadata value with 400 invalid_metadata", async () => {
    const agent = seedAgent();
    const response = await ME_PATCH(
      new Request(`${BASE}/api/v1/agents/me`, {
        ...authed(agent, { method: "PATCH", body: JSON.stringify({ metadata: ["nope"] }) }),
      }) as never
    );
    expect(response.status).toBe(400);
    expect(await body(response)).toEqual(errorBody("Invalid metadata", "metadata must be a plain object", "invalid_metadata"));
  });

  it("answers 200 with the unchanged profile for an empty body", async () => {
    const agent = seedAgent({ description: "unchanged" });
    const response = await ME_PATCH(
      new Request(`${BASE}/api/v1/agents/me`, {
        ...authed(agent, { method: "PATCH", body: JSON.stringify({}) }),
      }) as never
    );
    expect(response.status).toBe(200);
    expect((await body(response)).data).toMatchObject({ id: agent.id, description: "unchanged" });
  });

  it("answers 400 'Invalid body' for a body that is not JSON", async () => {
    const agent = seedAgent();
    const response = await ME_PATCH(
      new Request(`${BASE}/api/v1/agents/me`, { ...authed(agent, { method: "PATCH", body: "{" }) }) as never
    );
    expect(response.status).toBe(400);
    expect(await body(response)).toEqual(errorBody("Invalid body", undefined, "bad_request"));
  });

  it("answers 401 without a bearer token", async () => {
    const response = await ME_PATCH(
      new Request(`${BASE}/api/v1/agents/me`, {
        ...withMiddlewareHeaders({ method: "PATCH", body: JSON.stringify({ description: "x" }) }),
      }) as never
    );
    expect(response.status).toBe(401);
  });

  it("leaves the GET projection's own shape alone", async () => {
    const agent = seedAgent();
    const response = await ME_GET(
      new Request(`${BASE}/api/v1/agents/me`, { ...authed(agent) })
    );
    expect(response.status).toBe(200);
    const data = (await body(response)).data as Record<string, unknown>;
    expect(Object.keys(data).sort()).toEqual(
      [
        "ao_fellow",
        "ao_fellowship_cohort",
        "avatar_url",
        "created_at",
        "description",
        "display_name",
        "emoji",
        "follower_count",
        "following_count",
        "id",
        "is_active",
        "is_admitted",
        "is_claimed",
        "is_vetted",
        "last_active",
        "latest_announcement",
        "loop",
        "name",
        "points",
        "trust",
      ].sort()
    );
  });
});

// ---------------------------------------------------------------------------
// POST / DELETE /api/v1/agents/me/avatar
// ---------------------------------------------------------------------------

function avatarUpload(agent: StoredAgent, file: File): Request {
  const form = new FormData();
  form.set("file", file);
  return new Request(`${BASE}/api/v1/agents/me/avatar`, {
    ...authed(agent, { method: "POST", body: form }),
  });
}

describe("POST/DELETE /api/v1/agents/me/avatar", () => {
  it("stores a data URL and answers { avatar_url }", async () => {
    const agent = seedAgent();
    const response = await AVATAR_PUT(
      avatarUpload(agent, new File([new Uint8Array([1, 2, 3])], "a.png", { type: "image/png" })) as never
    );
    expect(response.status).toBe(200);
    const parsed = await body(response);
    expect(parsed.success).toBe(true);
    expect(String((parsed.data as Record<string, unknown>).avatar_url)).toMatch(/^data:image\/png;base64,/);
    expect(agents.get(agent.id)!.avatarUrl).toBe((parsed.data as Record<string, unknown>).avatar_url);
  });

  it("refuses a missing file, an oversized file and a disallowed type with their own 400 bodies", async () => {
    const agent = seedAgent();

    const noFile = await AVATAR_PUT(
      new Request(`${BASE}/api/v1/agents/me/avatar`, {
        ...authed(agent, { method: "POST", body: new FormData() }),
      }) as never
    );
    expect(noFile.status).toBe(400);
    expect(await body(noFile)).toEqual(errorBody("file is required", "Use multipart form with field 'file'", "bad_request"));

    const tooBig = await AVATAR_PUT(
      avatarUpload(agent, new File([new Uint8Array(500 * 1024 + 1)], "b.png", { type: "image/png" })) as never
    );
    expect(tooBig.status).toBe(400);
    expect(await body(tooBig)).toEqual(errorBody("File too large", "Max 500 KB", "bad_request"));

    const wrongType = await AVATAR_PUT(
      avatarUpload(agent, new File([new Uint8Array([1])], "c.txt", { type: "text/plain" })) as never
    );
    expect(wrongType.status).toBe(400);
    expect(await body(wrongType)).toEqual(errorBody("Invalid format", "Use JPEG, PNG, GIF, or WebP", "bad_request"));
  });

  it("removes the avatar with a message-only envelope, and says the same when there was none", async () => {
    const agent = seedAgent({ avatarUrl: "data:image/png;base64,AAA" });
    const removed = await AVATAR_DELETE(new Request(`${BASE}/api/v1/agents/me/avatar`, { ...authed(agent, { method: "DELETE" }) }));
    expect(removed.status).toBe(200);
    expect(await body(removed)).toEqual({ success: true, message: "Avatar removed" });
    expect(agents.get(agent.id)!.avatarUrl).toBeUndefined();

    const again = await AVATAR_DELETE(new Request(`${BASE}/api/v1/agents/me/avatar`, { ...authed(agent, { method: "DELETE" }) }));
    expect(again.status).toBe(200);
    expect(await body(again)).toEqual({ success: true, message: "Avatar removed" });
  });
});

// ---------------------------------------------------------------------------
// Inbox read-state
// ---------------------------------------------------------------------------

describe("inbox read-state", () => {
  it("marks one notification read and reports the recount", async () => {
    const agent = seedAgent();
    const one = seedNotification(agent.id);
    seedNotification(agent.id);

    const response = await INBOX_READ(
      new Request(`${BASE}/api/v1/agents/me/inbox/${one.id}/read`, { ...authed(agent, { method: "POST" }) }),
      { params: { notification_id: one.id } }
    );
    expect(response.status).toBe(200);
    expect(await body(response)).toEqual({
      success: true,
      data: { id: one.id, read: true, unread_count: 1 },
    });
    expect(notifications.get(one.id)!.read_at).not.toBeNull();
  });

  it("refuses a synthesized playground id with 409 read_state_unsupported", async () => {
    const agent = seedAgent();
    const response = await INBOX_READ(
      new Request(`${BASE}/api/v1/agents/me/inbox/playground:1/read`, { ...authed(agent, { method: "POST" }) }),
      { params: { notification_id: "playground:1" } }
    );
    expect(response.status).toBe(409);
    expect(await body(response)).toEqual(errorBody("Read state is not supported for synthesized playground notifications", undefined, "read_state_unsupported"));
  });

  it("answers 404 for an unknown id and for another agent's notification alike", async () => {
    const agent = seedAgent();
    const stranger = seedAgent();
    const theirs = seedNotification(stranger.id);

    for (const id of ["no-such-notification", theirs.id]) {
      const response = await INBOX_READ(
        new Request(`${BASE}/api/v1/agents/me/inbox/${id}/read`, { ...authed(agent, { method: "POST" }) }),
        { params: { notification_id: id } }
      );
      expect(response.status).toBe(404);
      expect(await body(response)).toEqual(errorBody("Notification not found", undefined, "not_found"));
    }
    expect(notifications.get(theirs.id)!.read_at).toBeNull();
  });

  it("marks every unread notification and reports both counts", async () => {
    const agent = seedAgent();
    seedNotification(agent.id);
    seedNotification(agent.id);
    seedNotification(agent.id, { read_at: new Date().toISOString() });

    const response = await INBOX_READ_ALL(
      new Request(`${BASE}/api/v1/agents/me/inbox/read-all`, { ...authed(agent, { method: "POST" }) })
    );
    expect(response.status).toBe(200);
    expect(await body(response)).toEqual({
      success: true,
      data: { marked_count: 2, unread_count: 0 },
    });
  });

  it("reports zero marked when there was nothing unread", async () => {
    const agent = seedAgent();
    const response = await INBOX_READ_ALL(
      new Request(`${BASE}/api/v1/agents/me/inbox/read-all`, { ...authed(agent, { method: "POST" }) })
    );
    expect(await body(response)).toEqual({ success: true, data: { marked_count: 0, unread_count: 0 } });
  });
});

// ---------------------------------------------------------------------------
// Memory context files — PUT / DELETE / the IDENTITY.md first-read backfill
// ---------------------------------------------------------------------------

describe("memory context file", () => {
  it("writes a file and answers the legacy-aliased envelope", async () => {
    const agent = seedAgent();
    const response = await CONTEXT_PUT(
      new Request(`${BASE}/api/v1/memory/context/file`, {
        ...authed(agent, { method: "PUT", body: JSON.stringify({ path: "notes.md", content: "hello" }) }),
      })
    );
    expect(response.status).toBe(200);
    const parsed = await body(response);
    const stored = await contextStore.getContextFile(agent.id, "notes.md");
    expect(stored).toEqual({ content: "hello", updatedAt: expect.any(String) });
    expect(parsed).toEqual({
      success: true,
      data: { path: "notes.md", updated_at: stored!.updatedAt },
      meta: { agent_id: agent.id },
      path: "notes.md",
      updated_at: stored!.updatedAt,
    });
  });

  it("defaults a missing content field to the empty string", async () => {
    const agent = seedAgent();
    await CONTEXT_PUT(
      new Request(`${BASE}/api/v1/memory/context/file`, {
        ...authed(agent, { method: "PUT", body: JSON.stringify({ path: "empty.md" }) }),
      })
    );
    expect((await contextStore.getContextFile(agent.id, "empty.md"))!.content).toBe("");
  });

  it("refuses a missing path, an invalid path and an unparseable body with their own 400 bodies", async () => {
    const agent = seedAgent();

    const noPath = await CONTEXT_PUT(
      new Request(`${BASE}/api/v1/memory/context/file`, {
        ...authed(agent, { method: "PUT", body: JSON.stringify({ content: "x" }) }),
      })
    );
    expect(noPath.status).toBe(400);
    expect(await body(noPath)).toEqual(errorBody("Bad Request", "path required", "bad_request"));

    const badPath = await CONTEXT_PUT(
      new Request(`${BASE}/api/v1/memory/context/file`, {
        ...authed(agent, { method: "PUT", body: JSON.stringify({ path: "../escape.md", content: "x" }) }),
      })
    );
    expect(badPath.status).toBe(400);
    expect(await body(badPath)).toEqual(errorBody("Bad Request", "invalid_path", "bad_request"));

    const badJson = await CONTEXT_PUT(
      new Request(`${BASE}/api/v1/memory/context/file`, { ...authed(agent, { method: "PUT", body: "{" }) })
    );
    expect(badJson.status).toBe(400);
    expect(await body(badJson)).toEqual(errorBody("Bad Request", "invalid JSON", "bad_request"));
  });

  it("deletes a file, says the same for a file that never existed, and refuses an invalid path", async () => {
    const agent = seedAgent();
    await contextStore.putContextFile(agent.id, "gone.md", "x");

    const deleted = await CONTEXT_DELETE(
      new Request(`${BASE}/api/v1/memory/context/file?path=gone.md`, { ...authed(agent, { method: "DELETE" }) })
    );
    expect(deleted.status).toBe(200);
    expect(await body(deleted)).toEqual({
      success: true,
      data: { deleted: true },
      meta: { agent_id: agent.id },
    });
    expect(await contextStore.getContextFile(agent.id, "gone.md")).toBeNull();

    const again = await CONTEXT_DELETE(
      new Request(`${BASE}/api/v1/memory/context/file?path=gone.md`, { ...authed(agent, { method: "DELETE" }) })
    );
    expect(again.status).toBe(200);
    expect(await body(again)).toEqual({
      success: true,
      data: { deleted: true },
      meta: { agent_id: agent.id },
    });

    const invalid = await CONTEXT_DELETE(
      new Request(`${BASE}/api/v1/memory/context/file?path=notmarkdown`, { ...authed(agent, { method: "DELETE" }) })
    );
    expect(invalid.status).toBe(400);
    expect(await body(invalid)).toEqual(errorBody("Bad Request", "invalid_path", "bad_request"));

    const noPath = await CONTEXT_DELETE(
      new Request(`${BASE}/api/v1/memory/context/file`, { ...authed(agent, { method: "DELETE" }) })
    );
    expect(noPath.status).toBe(400);
    expect(await body(noPath)).toEqual(errorBody("Bad Request", "path required", "bad_request"));
  });

  it("serves a stored file with source=context_file", async () => {
    const agent = seedAgent();
    await contextStore.putContextFile(agent.id, "read.md", "body");
    const response = await CONTEXT_GET(
      new Request(`${BASE}/api/v1/memory/context/file?path=read.md`, { ...authed(agent) })
    );
    expect(response.status).toBe(200);
    const stored = await contextStore.getContextFile(agent.id, "read.md");
    expect(await body(response)).toEqual({
      success: true,
      data: { path: "read.md", content: "body", updated_at: stored!.updatedAt, source: "context_file" },
      meta: { agent_id: agent.id },
      path: "read.md",
      content: "body",
      updated_at: stored!.updatedAt,
    });
  });

  it("backfills IDENTITY.md from the agent's bootstrap cache on first read (state-changing GET)", async () => {
    const agent = seedAgent({ identityMd: "# who I am" });
    expect(await contextStore.getContextFile(agent.id, "IDENTITY.md")).toBeNull();

    const response = await CONTEXT_GET(
      new Request(`${BASE}/api/v1/memory/context/file?path=IDENTITY.md`, { ...authed(agent) })
    );
    expect(response.status).toBe(200);
    const backfilled = await contextStore.getContextFile(agent.id, "IDENTITY.md");
    expect(backfilled).toEqual({ content: "# who I am", updatedAt: expect.any(String) });
    expect(await body(response)).toEqual({
      success: true,
      data: {
        path: "IDENTITY.md",
        content: "# who I am",
        updated_at: backfilled!.updatedAt,
        source: "agent_identity_cache",
      },
      meta: { agent_id: agent.id },
      path: "IDENTITY.md",
      content: "# who I am",
      updated_at: backfilled!.updatedAt,
    });
  });

  it("answers 404 for a missing file and for IDENTITY.md with no cache to backfill", async () => {
    const agent = seedAgent();
    for (const path of ["absent.md", "IDENTITY.md"]) {
      const response = await CONTEXT_GET(
        new Request(`${BASE}/api/v1/memory/context/file?path=${path}`, { ...authed(agent) })
      );
      expect(response.status).toBe(404);
      expect(await body(response)).toEqual(errorBody("Not found", undefined, "not_found"));
    }
  });

  it("answers 401 unauthenticated and 403 for another agent's id", async () => {
    const agent = seedAgent();
    const stranger = seedAgent();

    const anonymous = await CONTEXT_GET(
      new Request(`${BASE}/api/v1/memory/context/file?path=read.md`, { ...withMiddlewareHeaders() })
    );
    expect(anonymous.status).toBe(401);
    expect(await body(anonymous)).toEqual(errorBody("Unauthorized", undefined, "unauthorized"));

    const crossAgent = await CONTEXT_PUT(
      new Request(`${BASE}/api/v1/memory/context/file`, {
        ...authed(agent, {
          method: "PUT",
          body: JSON.stringify({ agent_id: stranger.id, path: "x.md", content: "x" }),
        }),
      })
    );
    expect(crossAgent.status).toBe(403);
    expect(await body(crossAgent)).toEqual(errorBody("Forbidden", undefined, "forbidden"));
  });
});

// ---------------------------------------------------------------------------
// Raw vector routes
// ---------------------------------------------------------------------------

describe("memory vector upsert / delete", () => {
  it("upserts and answers { id }", async () => {
    const agent = seedAgent();
    const response = await VECTOR_UPSERT(
      new Request(`${BASE}/api/v1/memory/vector/upsert`, {
        ...authed(agent, { method: "POST", body: JSON.stringify({ id: "v1", text: "remember" }) }),
      })
    );
    expect(response.status).toBe(200);
    expect(await body(response)).toEqual({
      success: true,
      data: { id: "v1" },
      meta: { agent_id: agent.id },
    });
  });

  it("refuses a missing id/text pair, an unparseable body, and over-long text", async () => {
    const agent = seedAgent();

    const missing = await VECTOR_UPSERT(
      new Request(`${BASE}/api/v1/memory/vector/upsert`, {
        ...authed(agent, { method: "POST", body: JSON.stringify({ text: "no id" }) }),
      })
    );
    expect(missing.status).toBe(400);
    expect(await body(missing)).toEqual(errorBody("Bad Request", "id and text required", "bad_request"));

    const badJson = await VECTOR_UPSERT(
      new Request(`${BASE}/api/v1/memory/vector/upsert`, { ...authed(agent, { method: "POST", body: "{" }) })
    );
    expect(badJson.status).toBe(400);
    expect(await body(badJson)).toEqual(errorBody("Bad Request", "invalid JSON", "bad_request"));

    const tooLong = await VECTOR_UPSERT(
      new Request(`${BASE}/api/v1/memory/vector/upsert`, {
        ...authed(agent, { method: "POST", body: JSON.stringify({ id: "v2", text: "x".repeat(200_001) }) }),
      })
    );
    expect(tooLong.status).toBe(400);
    expect(await body(tooLong)).toEqual(errorBody("Bad Request", "Memory text exceeds max length (200000 chars)", "bad_request"));
  });

  it("deletes by id list and refuses an empty one", async () => {
    const agent = seedAgent();
    const deleted = await VECTOR_DELETE(
      new Request(`${BASE}/api/v1/memory/vector/delete`, {
        ...authed(agent, { method: "POST", body: JSON.stringify({ ids: ["a", "b"] }) }),
      })
    );
    expect(deleted.status).toBe(200);
    expect(await body(deleted)).toEqual({
      success: true,
      data: { deleted: 2 },
      meta: { agent_id: agent.id },
    });

    const empty = await VECTOR_DELETE(
      new Request(`${BASE}/api/v1/memory/vector/delete`, {
        ...authed(agent, { method: "POST", body: JSON.stringify({ ids: [] }) }),
      })
    );
    expect(empty.status).toBe(400);
    expect(await body(empty)).toEqual(errorBody("Bad Request", "ids[] required", "bad_request"));
  });
});

// ---------------------------------------------------------------------------
// The two challenge-fetch GETs (state-changing GET, inventory §4)
// ---------------------------------------------------------------------------

describe("vetting challenge fetch", () => {
  it("returns values + nonce + hint and marks the challenge fetched", async () => {
    const agent = seedAgent();
    const challenge = seedChallenge(agent.id);
    const response = await VETTING_CHALLENGE(
      new Request(`${BASE}/api/v1/agents/vetting/challenge/${challenge.id}`, { ...withMiddlewareHeaders() }) as never,
      { params: Promise.resolve({ id: challenge.id }) }
    );
    expect(response.status).toBe(200);
    expect(await body(response)).toEqual({
      success: true,
      values: [3, 1, 2],
      nonce: "nonce-fixture",
      hint: "Sort the values array in ascending order, then compute SHA256(JSON.stringify(sortedValues) + nonce)",
    });
    expect(vettingChallenges.get(challenge.id)!.fetched).toBe(true);
  });

  it("answers 404 unknown, 410 consumed and 410 expired without marking anything", async () => {
    const agent = seedAgent();
    const consumed = seedChallenge(agent.id, { consumed: true });
    const expired = seedChallenge(agent.id, { expiresAt: new Date(Date.now() - 1000).toISOString() });

    const unknown = await VETTING_CHALLENGE(
      new Request(`${BASE}/api/v1/agents/vetting/challenge/nope`, { ...withMiddlewareHeaders() }) as never,
      { params: Promise.resolve({ id: "nope" }) }
    );
    expect(unknown.status).toBe(404);
    expect(await body(unknown)).toEqual(errorBody("Challenge not found", "Invalid challenge ID", "not_found"));

    const used = await VETTING_CHALLENGE(
      new Request(`${BASE}/api/v1/agents/vetting/challenge/${consumed.id}`, { ...withMiddlewareHeaders() }) as never,
      { params: Promise.resolve({ id: consumed.id }) }
    );
    expect(used.status).toBe(410);
    expect(await body(used)).toEqual(errorBody("Challenge already used", "This challenge has been consumed", "gone"));

    const stale = await VETTING_CHALLENGE(
      new Request(`${BASE}/api/v1/agents/vetting/challenge/${expired.id}`, { ...withMiddlewareHeaders() }) as never,
      { params: Promise.resolve({ id: expired.id }) }
    );
    expect(stale.status).toBe(410);
    expect(await body(stale)).toEqual(errorBody("Challenge expired", "Start a new vetting challenge", "gone"));

    expect(vettingChallenges.get(consumed.id)!.fetched).toBe(false);
    expect(vettingChallenges.get(expired.id)!.fetched).toBe(false);
  });

  it("serves the PoAW variant's own envelope, gated on ownership and on the evaluation id", async () => {
    const agent = seedAgent();
    const stranger = seedAgent();
    const challenge = seedChallenge(agent.id);

    const ok = await EVAL_CHALLENGE(
      new Request(`${BASE}/api/v1/evaluations/poaw/challenge/${challenge.id}`, { ...authed(agent) }) as never,
      { params: Promise.resolve({ id: "poaw", challengeId: challenge.id }) }
    );
    expect(ok.status).toBe(200);
    expect(await body(ok)).toEqual({
      success: true,
      challenge: {
        id: challenge.id,
        values: [3, 1, 2],
        nonce: "nonce-fixture",
        expires_at: challenge.expiresAt,
      },
    });
    expect(vettingChallenges.get(challenge.id)!.fetched).toBe(true);

    const wrongEvaluation = await EVAL_CHALLENGE(
      new Request(`${BASE}/api/v1/evaluations/other/challenge/${challenge.id}`, { ...authed(agent) }) as never,
      { params: Promise.resolve({ id: "other", challengeId: challenge.id }) }
    );
    expect(wrongEvaluation.status).toBe(400);
    expect(await body(wrongEvaluation)).toEqual(errorBody("Invalid evaluation", "This endpoint is only for PoAW", "bad_request"));

    const notMine = seedChallenge(agent.id);
    const mismatched = await EVAL_CHALLENGE(
      new Request(`${BASE}/api/v1/evaluations/poaw/challenge/${notMine.id}`, { ...authed(stranger) }) as never,
      { params: Promise.resolve({ id: "poaw", challengeId: notMine.id }) }
    );
    expect(mismatched.status).toBe(403);
    expect(await body(mismatched)).toEqual(errorBody("Challenge mismatch", "This challenge was not issued to your agent", "forbidden"));
    expect(vettingChallenges.get(notMine.id)!.fetched).toBe(false);

    const unknown = await EVAL_CHALLENGE(
      new Request(`${BASE}/api/v1/evaluations/poaw/challenge/nope`, { ...authed(agent) }) as never,
      { params: Promise.resolve({ id: "poaw", challengeId: "nope" }) }
    );
    expect(unknown.status).toBe(404);
    expect(await body(unknown)).toEqual(errorBody("Challenge not found", undefined, "not_found"));
  });
});

// ---------------------------------------------------------------------------
// The tool surfaces
// ---------------------------------------------------------------------------

describe("agent tools", () => {
  it("update_my_profile echoes the camelCase updates it applied", async () => {
    const agent = seedAgent();
    const result = await agentTools.update_my_profile!(
      { display_name: "Tooled", description: "via tool" },
      toolContext(agent)
    );
    expect(result).toEqual({
      success: true,
      data: { updated: true, displayName: "Tooled", description: "via tool" },
    });
    expect(agents.get(agent.id)!.displayName).toBe("Tooled");
    expect(agents.get(agent.id)!.description).toBe("via tool");
  });

  it("update_my_profile treats empty strings as absent and still answers updated: true", async () => {
    const agent = seedAgent({ description: "kept" });
    const result = await agentTools.update_my_profile!({ display_name: "", description: "" }, toolContext(agent));
    expect(result).toEqual({ success: true, data: { updated: true } });
    expect(agents.get(agent.id)!.description).toBe("kept");
  });

  it("has NO metadata parameter on update_my_profile — the tool cannot reach reserved keys", async () => {
    // Recorded as a pin, not an omission: the reserved-key rule moves into the action, and this is
    // why the tool adapter can never exercise it. A later diff that adds `metadata` here has to
    // change this test, which is the point.
    const agent = seedAgent();
    const result = await agentTools.update_my_profile!(
      { metadata: { ao_fellow: true }, description: "d" } as never,
      toolContext(agent)
    );
    expect(result).toEqual({ success: true, data: { updated: true, description: "d" } });
    expect(agents.get(agent.id)!.metadata).toBeUndefined();
  });

  it("put_context_file answers { path, saved } and delete_context_file answers { deleted }", async () => {
    const agent = seedAgent();
    expect(await memoryTools.put_context_file!({ path: "tool.md", content: "c" }, toolContext(agent))).toEqual({
      success: true,
      data: { path: "tool.md", saved: true },
    });
    expect((await contextStore.getContextFile(agent.id, "tool.md"))!.content).toBe("c");

    expect(await memoryTools.delete_context_file!({ path: "tool.md" }, toolContext(agent))).toEqual({
      success: true,
      data: { deleted: true },
    });
    expect(await contextStore.getContextFile(agent.id, "tool.md")).toBeNull();
  });

  it("both memory tools refuse an invalid path with the raw domain string", async () => {
    const agent = seedAgent();
    expect(await memoryTools.put_context_file!({ path: "../x.md", content: "c" }, toolContext(agent))).toEqual({
      success: false,
      error: "invalid_path",
    });
    expect(await memoryTools.delete_context_file!({ path: "../x.md" }, toolContext(agent))).toEqual({
      success: false,
      error: "invalid_path",
    });
  });
});
