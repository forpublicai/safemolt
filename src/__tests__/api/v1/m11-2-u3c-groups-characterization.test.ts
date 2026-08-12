/**
 * M11-2 u3c (P1.3) — CHARACTERIZATION. The exact wire shapes the group surfaces answer with
 * **today**, pinned before any of them becomes an adapter.
 *
 * P1.3 turns eight route handlers and seven tool executors into adapters over
 * `src/lib/actions/groups.ts`. The whole value of that refactor depends on nothing an agent can
 * observe changing, and "nothing changed" is not a claim a diff can make: the route bodies are
 * assembled from `errorResponse`'s envelope, the school gate's own envelope and hand-written hints,
 * and the tool bodies are a third shape again. So every one of them is pinned here, field for
 * field, **before** the refactor — and this file is then re-run against the adapters.
 *
 * **Every pin below was derived from the PRE-u3c source, at `HEAD@a7f4cd3`**: none of
 * `src/app/api/v1/groups/**` or `src/lib/agent-tools/definitions/groups.ts` is touched by u1–u3b,
 * so HEAD and the working tree agree on them and the provenance is exact. That matters: a
 * characterization suite written by reading the *refactored* code proves the refactor is
 * self-consistent and nothing more.
 *
 * **One wire behavior changes on purpose**, and it has its own test at the bottom rather than a
 * silently adjusted pin: `update_group_settings` (the TOOL) applies no ownership check at all
 * today, so any agent can rename any group through it. The route has always required the owner.
 * P1.3 moves that authorization into the action, which both surfaces then share — the drift this
 * milestone exists to close, and here it is also a live authorization hole. The pre-fix behavior is
 * recorded below in `describe("recorded behavior changes")` so the change is visible rather than
 * absorbed.
 *
 * A second change is not visible here at all — a duplicate join no longer refreshes the activity
 * trail — because it is a projection, not a response; its gates live in
 * `src/__tests__/lib/actions/groups.test.ts` and the u3c integration suite.
 *
 * `request_id` and `X-Request-Id` are generated per response and are the only fields excluded.
 *
 * No mocks: Jest runs with no database, so `@/lib/store` *is* the memory store.
 *
 * @jest-environment node
 */
// `POST /api/v1/groups` reads `x-school-id` through `next/headers`, which needs a request scope a
// hand-built `Request` does not create. The same stand-in every route suite uses.
jest.mock("next/headers", () => ({
  headers: jest.fn(async () => new Headers({ "x-school-id": "foundation" })),
}));

import { POST as CREATE_GROUP } from "@/app/api/v1/groups/route";
import { POST as JOIN } from "@/app/api/v1/groups/[name]/join/route";
import { POST as LEAVE } from "@/app/api/v1/groups/[name]/leave/route";
import { POST as SUBSCRIBE, DELETE as UNSUBSCRIBE } from "@/app/api/v1/groups/[name]/subscribe/route";
import { PATCH as SETTINGS } from "@/app/api/v1/groups/[name]/settings/route";
import {
  POST as ADD_MODERATOR,
  DELETE as REMOVE_MODERATOR,
} from "@/app/api/v1/groups/[name]/moderators/route";
import { executors as groupTools } from "@/lib/agent-tools/definitions/groups";
import { createAgent, getAgentById, setAgentVetted } from "@/lib/store/agents/memory";
import { createGroup, getGroup, joinGroup } from "@/lib/store/groups/memory";
import { clearRateWindows } from "@/__tests__/helpers/store-fixtures";
import { agents, resetGroupState } from "@/lib/store/_memory-state";
import type { StoredAgent } from "@/lib/store-types";
import { withMiddlewareHeaders } from "../../helpers/middleware-headers";

let seq = 0;
const nextName = (label: string) => `u3cc${label}${Date.now().toString(36)}${(seq += 1)}`;

async function agent(label: string, options: { vetted?: boolean } = {}): Promise<StoredAgent> {
  const created = await createAgent(nextName(label), "u3c characterization fixture");
  if (options.vetted !== false) await setAgentVetted(created.id, `# ${label}\n`);
  return (await getAgentById(created.id))!;
}

async function group(owner: StoredAgent, options: { schoolId?: string } = {}) {
  return createGroup(nextName("grp"), "U3c characterization", "a group", owner.id, options.schoolId);
}

function request(caller: StoredAgent, url: string, method: string, body?: unknown): Request {
  return new Request(
    `https://safemolt.com${url}`,
    withMiddlewareHeaders({
      method,
      headers: {
        Authorization: `Bearer ${caller.apiKey}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  );
}

/** The response body minus the per-response request id. */
async function body(response: Response): Promise<Record<string, unknown>> {
  const parsed = (await response.json()) as Record<string, unknown>;
  delete parsed.request_id;
  return parsed;
}

const params = <T extends Record<string, string>>(value: T) => ({ params: Promise.resolve(value) });

const tool = (name: string, caller: StoredAgent, args: Record<string, unknown>) =>
  groupTools[name](args, { agent: caller } as never);

beforeEach(() => {
  clearRateWindows();
});

describe("POST /api/v1/groups — response shapes", () => {
  it("answers the success envelope with the created group's fields", async () => {
    const creator = await agent("creator");
    const name = nextName("newgrp");

    const response = await CREATE_GROUP(
      request(creator, "/api/v1/groups", "POST", {
        name,
        display_name: "Display",
        description: " desc ",
      }) as never
    );

    expect(response.status).toBe(200);
    expect(await body(response)).toEqual({
      success: true,
      data: {
        id: name,
        name,
        display_name: "Display",
        description: "desc",
        type: "group",
        // The three house-shaped keys survive as literal nulls for one deprecation cycle.
        points: null,
        founder_id: null,
        required_evaluation_ids: null,
        member_count: 1,
        banner_color: null,
        theme_color: null,
        emoji: null,
        created_at: expect.any(String),
      },
    });
  });

  it("defaults display_name to the normalized name", async () => {
    const creator = await agent("creator2");
    const name = nextName("defaulted");
    const response = await CREATE_GROUP(
      request(creator, "/api/v1/groups", "POST", { name }) as never
    );
    const parsed = await body(response);
    expect((parsed.data as Record<string, unknown>).display_name).toBe(name);
    expect((parsed.data as Record<string, unknown>).description).toBe("");
  });

  it("answers 400 when name is missing", async () => {
    const creator = await agent("creator3");
    const response = await CREATE_GROUP(request(creator, "/api/v1/groups", "POST", {}) as never);

    expect(response.status).toBe(400);
    expect(await body(response)).toEqual({
      success: false,
      error: "name is required",
      error_detail: { code: "bad_request", message: "name is required" },
    });
  });

  it("answers 400 for a type that is neither group nor house", async () => {
    const creator = await agent("creator4");
    const response = await CREATE_GROUP(
      request(creator, "/api/v1/groups", "POST", { name: nextName("typed"), type: "hosue" }) as never
    );

    expect(response.status).toBe(400);
    expect(await body(response)).toEqual({
      success: false,
      error: 'type must be "group"',
      hint: 'Houses are removed; omit type or send "group".',
      error_detail: {
        code: "bad_request",
        message: 'type must be "group"',
        hint: 'Houses are removed; omit type or send "group".',
      },
    });
  });

  it("accepts the legacy type values and still answers a plain group", async () => {
    const creator = await agent("creator5");
    for (const type of ["group", "house", null, ""]) {
      const response = await CREATE_GROUP(
        request(creator, "/api/v1/groups", "POST", { name: nextName("legacy"), type }) as never
      );
      expect(response.status).toBe(200);
      expect(((await body(response)).data as Record<string, unknown>).type).toBe("group");
    }
  });

  it("answers 409 for a name that already exists", async () => {
    const creator = await agent("creator6");
    const existing = await group(creator);

    const response = await CREATE_GROUP(
      request(creator, "/api/v1/groups", "POST", { name: existing.name }) as never
    );

    expect(response.status).toBe(409);
    expect(await body(response)).toEqual({
      success: false,
      error: "Group already exists",
      error_detail: { code: "conflict", message: "Group already exists" },
    });
  });
});

describe("POST /api/v1/groups/{name}/join — response shapes", () => {
  it("answers the join envelope with the group's three fields", async () => {
    const owner = await agent("jowner");
    const g = await group(owner);
    const joiner = await agent("joiner");

    const response = await JOIN(
      request(joiner, `/api/v1/groups/${g.name}/join`, "POST") as never,
      params({ name: g.name })
    );

    expect(response.status).toBe(200);
    expect(await body(response)).toEqual({
      success: true,
      message: "Successfully joined group",
      data: { id: g.id, name: g.name, type: "group" },
    });
  });

  it("answers the already-a-member envelope, which carries no data at all", async () => {
    const owner = await agent("jowner2");
    const g = await group(owner);
    const joiner = await agent("joiner2");
    await joinGroup(joiner.id, g.id);

    const response = await JOIN(
      request(joiner, `/api/v1/groups/${g.name}/join`, "POST") as never,
      params({ name: g.name })
    );

    expect(response.status).toBe(200);
    expect(await body(response)).toEqual({
      success: true,
      message: "Already a member of this group",
    });
  });

  it("answers 404 for an unknown group", async () => {
    const joiner = await agent("joiner3");
    const response = await JOIN(
      request(joiner, "/api/v1/groups/nope/join", "POST") as never,
      params({ name: "nope" })
    );

    expect(response.status).toBe(404);
    expect(await body(response)).toEqual({
      success: false,
      error: "Group not found",
      error_detail: { code: "not_found", message: "Group not found" },
    });
  });

  it("answers the school gate's own 403 envelope for an unvetted joiner", async () => {
    const owner = await agent("jowner4");
    const g = await group(owner);
    const unvetted = await agent("junvetted", { vetted: false });

    const response = await JOIN(
      request(unvetted, `/api/v1/groups/${g.name}/join`, "POST") as never,
      params({ name: g.name })
    );

    expect(response.status).toBe(403);
    expect(await body(response)).toEqual({
      success: false,
      error: "Agent must be vetted to access the Foundation School",
      hint: "Complete the vetting challenge first. POST to /api/v1/agents/vetting/start",
      error_detail: {
        code: "forbidden",
        message: "Agent must be vetted to access the Foundation School",
        hint: "Complete the vetting challenge first. POST to /api/v1/agents/vetting/start",
      },
      vetting_required: true,
    });
  });
});

describe("POST /api/v1/groups/{name}/leave — response shapes", () => {
  it("answers the bare success message", async () => {
    const owner = await agent("lowner");
    const g = await group(owner);
    const member = await agent("leaver");
    await joinGroup(member.id, g.id);

    const response = await LEAVE(
      request(member, `/api/v1/groups/${g.name}/leave`, "POST") as never,
      params({ name: g.name })
    );

    expect(response.status).toBe(200);
    expect(await body(response)).toEqual({ success: true, message: "Successfully left group" });
  });

  it("answers 400 with the store's own wording for a non-member", async () => {
    const owner = await agent("lowner2");
    const g = await group(owner);
    const stranger = await agent("stranger");

    const response = await LEAVE(
      request(stranger, `/api/v1/groups/${g.name}/leave`, "POST") as never,
      params({ name: g.name })
    );

    expect(response.status).toBe(400);
    expect(await body(response)).toEqual({
      success: false,
      error: "Not a member of this group",
      error_detail: { code: "bad_request", message: "Not a member of this group" },
    });
  });

  it("answers 404 for an unknown group", async () => {
    const caller = await agent("lstranger");
    const response = await LEAVE(
      request(caller, "/api/v1/groups/nope/leave", "POST") as never,
      params({ name: "nope" })
    );
    expect(response.status).toBe(404);
    expect(await body(response)).toEqual({
      success: false,
      error: "Group not found",
      error_detail: { code: "not_found", message: "Group not found" },
    });
  });
});

describe("POST and DELETE /api/v1/groups/{name}/subscribe — response shapes", () => {
  it("answers the bare Subscribed / Unsubscribed messages", async () => {
    const owner = await agent("sowner");
    const g = await group(owner);
    const reader = await agent("reader");

    const subscribed = await SUBSCRIBE(
      request(reader, `/api/v1/groups/${g.name}/subscribe`, "POST") as never,
      params({ name: g.name })
    );
    expect(subscribed.status).toBe(200);
    expect(await body(subscribed)).toEqual({ success: true, message: "Subscribed" });

    const unsubscribed = await UNSUBSCRIBE(
      request(reader, `/api/v1/groups/${g.name}/subscribe`, "DELETE") as never,
      params({ name: g.name })
    );
    expect(unsubscribed.status).toBe(200);
    expect(await body(unsubscribed)).toEqual({ success: true, message: "Unsubscribed" });
  });

  it("answers 200 for a duplicate subscribe and for an unsubscribe that removes nothing", async () => {
    // Both surfaces discard the store's boolean today, so neither duplicate is visible on the wire.
    const owner = await agent("sowner2");
    const g = await group(owner);
    const reader = await agent("reader2");

    await SUBSCRIBE(
      request(reader, `/api/v1/groups/${g.name}/subscribe`, "POST") as never,
      params({ name: g.name })
    );
    const again = await SUBSCRIBE(
      request(reader, `/api/v1/groups/${g.name}/subscribe`, "POST") as never,
      params({ name: g.name })
    );
    expect(again.status).toBe(200);
    expect(await body(again)).toEqual({ success: true, message: "Subscribed" });

    const stranger = await agent("sstranger");
    const removed = await UNSUBSCRIBE(
      request(stranger, `/api/v1/groups/${g.name}/subscribe`, "DELETE") as never,
      params({ name: g.name })
    );
    expect(removed.status).toBe(200);
    expect(await body(removed)).toEqual({ success: true, message: "Unsubscribed" });
  });

  it("answers 404 for an unknown group on both methods", async () => {
    const caller = await agent("s404");
    for (const handler of [SUBSCRIBE, UNSUBSCRIBE]) {
      const response = await handler(
        request(caller, "/api/v1/groups/nope/subscribe", "POST") as never,
        params({ name: "nope" })
      );
      expect(response.status).toBe(404);
      expect(await body(response)).toEqual({
        success: false,
        error: "Group not found",
        error_detail: { code: "not_found", message: "Group not found" },
      });
    }
  });
});

describe("PATCH /api/v1/groups/{name}/settings — response shapes", () => {
  it("answers the updated group's seven fields", async () => {
    const owner = await agent("setowner");
    const g = await group(owner);

    const response = await SETTINGS(
      request(owner, `/api/v1/groups/${g.name}/settings`, "PATCH", {
        description: " new description ",
        display_name: " New Display ",
        banner_color: "#111111",
        theme_color: "#222222",
        emoji: "🦉",
      }) as never,
      params({ name: g.name })
    );

    expect(response.status).toBe(200);
    expect(await body(response)).toEqual({
      success: true,
      data: {
        id: g.id,
        name: g.name,
        display_name: "New Display",
        description: "new description",
        banner_color: "#111111",
        theme_color: "#222222",
        emoji: "🦉",
      },
    });
  });

  it("clears the emoji when an empty string is sent", async () => {
    const owner = await agent("setowner2");
    const g = await group(owner);
    await SETTINGS(
      request(owner, `/api/v1/groups/${g.name}/settings`, "PATCH", { emoji: "🦉" }) as never,
      params({ name: g.name })
    );

    const response = await SETTINGS(
      request(owner, `/api/v1/groups/${g.name}/settings`, "PATCH", { emoji: "" }) as never,
      params({ name: g.name })
    );

    expect(((await body(response)).data as Record<string, unknown>).emoji).toBeNull();
  });

  it("answers 403 for a non-owner", async () => {
    const owner = await agent("setowner3");
    const g = await group(owner);
    const intruder = await agent("intruder");

    const response = await SETTINGS(
      request(intruder, `/api/v1/groups/${g.name}/settings`, "PATCH", { description: "mine" }) as never,
      params({ name: g.name })
    );

    expect(response.status).toBe(403);
    expect(await body(response)).toEqual({
      success: false,
      error: "Forbidden",
      hint: "Only the owner can update settings",
      error_detail: { code: "forbidden", message: "Forbidden", hint: "Only the owner can update settings" },
    });
    expect((await getGroup(g.id))!.description).toBe("a group");
  });

  it("answers 400 when the body is not JSON", async () => {
    const owner = await agent("setowner4");
    const g = await group(owner);

    const response = await SETTINGS(
      new Request(`https://safemolt.com/api/v1/groups/${g.name}/settings`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${owner.apiKey}`, "x-school-id": "foundation" },
      }) as never,
      params({ name: g.name })
    );

    expect(response.status).toBe(400);
    expect(await body(response)).toEqual({
      success: false,
      error: "Use application/json for PATCH",
      error_detail: { code: "bad_request", message: "Use application/json for PATCH" },
    });
  });

  it("answers 404 for an unknown group", async () => {
    const caller = await agent("set404");
    const response = await SETTINGS(
      request(caller, "/api/v1/groups/nope/settings", "PATCH", { description: "x" }) as never,
      params({ name: "nope" })
    );
    expect(response.status).toBe(404);
    expect(await body(response)).toEqual({
      success: false,
      error: "Group not found",
      error_detail: { code: "not_found", message: "Group not found" },
    });
  });
});

describe("POST and DELETE /api/v1/groups/{name}/moderators — response shapes", () => {
  it("answers the add message naming the agent", async () => {
    const owner = await agent("mowner");
    const g = await group(owner);
    const target = await agent("modtarget");

    const response = await ADD_MODERATOR(
      request(owner, `/api/v1/groups/${g.name}/moderators`, "POST", { agent_name: target.name }) as never,
      params({ name: g.name })
    );

    expect(response.status).toBe(200);
    expect(await body(response)).toEqual({
      success: true,
      message: `Added ${target.name} as moderator`,
    });
  });

  it("answers 403 with one string for a non-owner AND for an unknown agent name", async () => {
    const owner = await agent("mowner2");
    const g = await group(owner);
    const intruder = await agent("mintruder");
    const target = await agent("modtarget2");

    const byIntruder = await ADD_MODERATOR(
      request(intruder, `/api/v1/groups/${g.name}/moderators`, "POST", { agent_name: target.name }) as never,
      params({ name: g.name })
    );
    const unknownAgent = await ADD_MODERATOR(
      request(owner, `/api/v1/groups/${g.name}/moderators`, "POST", { agent_name: "no_such_agent" }) as never,
      params({ name: g.name })
    );

    for (const response of [byIntruder, unknownAgent]) {
      expect(response.status).toBe(403);
      expect(await body(response)).toEqual({
        success: false,
        error: "Forbidden or agent not found",
        hint: "Only owner can add moderators",
        error_detail: {
          code: "forbidden",
          message: "Forbidden or agent not found",
          hint: "Only owner can add moderators",
        },
      });
    }
  });

  it("answers 400 when agent_name is missing, on both methods", async () => {
    const owner = await agent("mowner3");
    const g = await group(owner);

    for (const handler of [ADD_MODERATOR, REMOVE_MODERATOR]) {
      const response = await handler(
        request(owner, `/api/v1/groups/${g.name}/moderators`, "POST", {}) as never,
        params({ name: g.name })
      );
      expect(response.status).toBe(400);
      expect(await body(response)).toEqual({
        success: false,
        error: "agent_name is required",
        error_detail: { code: "bad_request", message: "agent_name is required" },
      });
    }
  });

  /**
   * **The removal route publishes success whatever happened**, including for a caller who owns
   * nothing. It discards the store's boolean, so a non-owner's removal and an unknown name both
   * answer 200 with the same message. The TOOL surface reports the same two cases as failures —
   * a route/tool divergence this suite records rather than resolves, because resolving it would be
   * a wire change P1.3 does not make.
   */
  it("answers 200 for a removal that removed nothing, and for a non-owner", async () => {
    const owner = await agent("mowner4");
    const g = await group(owner);
    const intruder = await agent("mintruder2");
    const target = await agent("modtarget3");

    const neverAModerator = await REMOVE_MODERATOR(
      request(owner, `/api/v1/groups/${g.name}/moderators`, "DELETE", { agent_name: target.name }) as never,
      params({ name: g.name })
    );
    expect(neverAModerator.status).toBe(200);
    expect(await body(neverAModerator)).toEqual({
      success: true,
      message: `Removed ${target.name} as moderator`,
    });

    const byIntruder = await REMOVE_MODERATOR(
      request(intruder, `/api/v1/groups/${g.name}/moderators`, "DELETE", { agent_name: target.name }) as never,
      params({ name: g.name })
    );
    expect(byIntruder.status).toBe(200);
    expect(await body(byIntruder)).toEqual({
      success: true,
      message: `Removed ${target.name} as moderator`,
    });
  });

  it("removes a real moderator", async () => {
    const owner = await agent("mowner5");
    const g = await group(owner);
    const target = await agent("modtarget4");

    await ADD_MODERATOR(
      request(owner, `/api/v1/groups/${g.name}/moderators`, "POST", { agent_name: target.name }) as never,
      params({ name: g.name })
    );
    expect((await getGroup(g.id))!.moderatorIds).toEqual([target.id]);

    await REMOVE_MODERATOR(
      request(owner, `/api/v1/groups/${g.name}/moderators`, "DELETE", { agent_name: target.name }) as never,
      params({ name: g.name })
    );
    expect((await getGroup(g.id))!.moderatorIds).toEqual([]);
  });

  it("answers 404 for an unknown group on both methods", async () => {
    const caller = await agent("m404");
    for (const handler of [ADD_MODERATOR, REMOVE_MODERATOR]) {
      const response = await handler(
        request(caller, "/api/v1/groups/nope/moderators", "POST", { agent_name: "x" }) as never,
        params({ name: "nope" })
      );
      expect(response.status).toBe(404);
      expect(await body(response)).toEqual({
        success: false,
        error: "Group not found",
        error_detail: { code: "not_found", message: "Group not found" },
      });
    }
  });
});

describe("group tool executors — result shapes", () => {
  it("join_group answers the joined name, and repeats it for a duplicate", async () => {
    const owner = await agent("tjowner");
    const g = await group(owner);
    const joiner = await agent("tjoiner");

    expect(await tool("join_group", joiner, { group_name: g.name })).toEqual({
      success: true,
      data: { joined: g.name },
    });
    // The duplicate is indistinguishable on this surface, and stays so.
    expect(await tool("join_group", joiner, { group_name: g.name })).toEqual({
      success: true,
      data: { joined: g.name },
    });
  });

  it("join_group answers its own not-found string, which quotes the name", async () => {
    const joiner = await agent("tj404");
    expect(await tool("join_group", joiner, { group_name: "nope" })).toEqual({
      success: false,
      error: 'Group "nope" not found',
    });
  });

  it("join_group answers the school denial with its code", async () => {
    const owner = await agent("tjowner2");
    const g = await group(owner);
    const unvetted = await agent("tjunvetted", { vetted: false });

    expect(await tool("join_group", unvetted, { group_name: g.name })).toEqual({
      success: false,
      error: "Agent must be vetted to act in this group",
      data: { code: "vetting_required" },
    });
  });

  it("leave_group answers the left name, and the store's refusal for a non-member", async () => {
    const owner = await agent("tlowner");
    const g = await group(owner);
    const member = await agent("tleaver");
    await joinGroup(member.id, g.id);

    expect(await tool("leave_group", member, { group_name: g.name })).toEqual({
      success: true,
      data: { left: g.name },
    });
    expect(await tool("leave_group", member, { group_name: g.name })).toEqual({
      success: false,
      error: "Not a member of this group",
    });
    expect(await tool("leave_group", member, { group_name: "nope" })).toEqual({
      success: false,
      error: "Group not found",
    });
  });

  it("subscribe_to_group and unsubscribe_from_group answer the name back", async () => {
    const owner = await agent("tsowner");
    const g = await group(owner);
    const reader = await agent("treader");

    expect(await tool("subscribe_to_group", reader, { group_name: g.name })).toEqual({
      success: true,
      data: { subscribed: g.name },
    });
    expect(await tool("unsubscribe_from_group", reader, { group_name: g.name })).toEqual({
      success: true,
      data: { unsubscribed: g.name },
    });
    for (const name of ["subscribe_to_group", "unsubscribe_from_group"]) {
      expect(await tool(name, reader, { group_name: "nope" })).toEqual({
        success: false,
        error: "Group not found",
      });
    }
  });

  it("add_moderator and remove_moderator answer the target name, or one refusal string each", async () => {
    const owner = await agent("tmowner");
    const g = await group(owner);
    const target = await agent("tmtarget");
    const intruder = await agent("tmintruder");

    expect(await tool("add_moderator", owner, { group_name: g.name, agent_name: target.name })).toEqual({
      success: true,
      data: { added_moderator: target.name },
    });
    expect(await tool("add_moderator", intruder, { group_name: g.name, agent_name: target.name })).toEqual({
      success: false,
      error: "Could not add moderator (must be group owner)",
    });
    expect(await tool("add_moderator", owner, { group_name: g.name, agent_name: "no_such_agent" })).toEqual({
      success: false,
      error: "Could not add moderator (must be group owner)",
    });

    expect(await tool("remove_moderator", owner, { group_name: g.name, agent_name: target.name })).toEqual({
      success: true,
      data: { removed_moderator: target.name },
    });
    expect(await tool("remove_moderator", intruder, { group_name: g.name, agent_name: target.name })).toEqual({
      success: false,
      error: "Could not remove moderator (must be group owner)",
    });
    expect(await tool("remove_moderator", owner, { group_name: g.name, agent_name: "no_such_agent" })).toEqual({
      success: false,
      error: "Could not remove moderator (must be group owner)",
    });
  });

  /**
   * **A removal that removes nothing still answers success on this surface**, because the store
   * updates unconditionally once the caller is the owner and the target name resolves. The event
   * gate P1.3 adds is keyed to the row actually changing, so this success must survive while the
   * event does not fire.
   */
  it("remove_moderator answers success for an agent who was never a moderator", async () => {
    const owner = await agent("tmowner2");
    const g = await group(owner);
    const target = await agent("tmtarget2");

    expect(await tool("remove_moderator", owner, { group_name: g.name, agent_name: target.name })).toEqual({
      success: true,
      data: { removed_moderator: target.name },
    });
  });

  it("update_group_settings answers the group name back, and 'Group not found' otherwise", async () => {
    const owner = await agent("tuowner");
    const g = await group(owner);

    expect(
      await tool("update_group_settings", owner, {
        group_name: g.name,
        display_name: "Renamed",
        description: "Rewritten",
        emoji: "🐛",
      })
    ).toEqual({ success: true, data: { updated: g.name } });
    const updated = (await getGroup(g.id))!;
    expect([updated.displayName, updated.description, updated.emoji]).toEqual([
      "Renamed",
      "Rewritten",
      "🐛",
    ]);

    expect(await tool("update_group_settings", owner, { group_name: "nope" })).toEqual({
      success: false,
      error: "Group not found",
    });
  });

  /**
   * **Clearing an emoji through the tool** (codex round 4, finding 3).
   *
   * The shared settings contract says key PRESENCE clears the emoji — a truthiness test drops
   * `emoji: ""`, so an owner who set an emoji and then cleared it got success while the emoji stayed
   * and no event fired. The fixture has to START with a populated emoji, or it cannot tell clearing
   * from ignoring.
   */
  it("update_group_settings clears a populated emoji when sent an empty string", async () => {
    const owner = await agent("tuowner3");
    const g = await group(owner);
    await tool("update_group_settings", owner, { group_name: g.name, emoji: "🦉" });
    expect((await getGroup(g.id))!.emoji).toBe("🦉");

    expect(await tool("update_group_settings", owner, { group_name: g.name, emoji: "" })).toEqual({
      success: true,
      data: { updated: g.name },
    });

    expect((await getGroup(g.id))!.emoji).toBeUndefined();
  });

  it("update_group_settings ignores falsy fields entirely", async () => {
    const owner = await agent("tuowner2");
    const g = await group(owner);
    await tool("update_group_settings", owner, { group_name: g.name, display_name: "Kept", emoji: "" });
    const updated = (await getGroup(g.id))!;
    expect(updated.displayName).toBe("Kept");
    expect(updated.emoji).toBeUndefined();
  });
});

/**
 * The changes P1.3 makes on purpose, recorded as tests rather than absorbed into the pins above.
 *
 * Both are ONE defect: the tool surface applied no ownership check where the route always has, so
 * the two surfaces answered differently for the same request. P1.3 moves the decision into the
 * action, which is the layer both of them go through.
 */
describe("recorded behavior changes (u3c)", () => {
  it("update_group_settings refuses a non-owner, which it did not before", async () => {
    const owner = await agent("cuowner");
    const g = await group(owner);
    const intruder = await agent("cuintruder");

    const result = await tool("update_group_settings", intruder, {
      group_name: g.name,
      display_name: "Hijacked",
    });

    expect(result).toEqual({
      success: false,
      error: "Could not update group settings (must be group owner)",
    });
    // The pre-u3c tool wrote this field for any caller at all.
    expect((await getGroup(g.id))!.displayName).toBe("U3c characterization");
  });

  /**
   * **Malformed requests are now refused before the group is resolved**, on the two routes whose
   * body parsing used to sit after the 404 and the school gate. The u3b precedent is the same: the
   * comment route began validating its body first for the same reason. It leaks less — a malformed
   * request no longer reports whether a group name exists — and every well-formed request is
   * unaffected, which is why the pins above did not move.
   */
  it("answers 400 rather than 404 for a malformed request naming an unknown group", async () => {
    const caller = await agent("corder");

    const settings = await SETTINGS(
      new Request("https://safemolt.com/api/v1/groups/nope/settings", {
        method: "PATCH",
        headers: { Authorization: `Bearer ${caller.apiKey}`, "x-school-id": "foundation" },
      }) as never,
      params({ name: "nope" })
    );
    expect(settings.status).toBe(400);
    expect((await body(settings)).error).toBe("Use application/json for PATCH");

    const moderators = await ADD_MODERATOR(
      request(caller, "/api/v1/groups/nope/moderators", "POST", {}) as never,
      params({ name: "nope" })
    );
    expect(moderators.status).toBe(400);
    expect((await body(moderators)).error).toBe("agent_name is required");
  });

  it("still lets the owner through, so the fix is a gate rather than a wall", async () => {
    const owner = await agent("cuowner2");
    const g = await group(owner);

    expect(
      await tool("update_group_settings", owner, { group_name: g.name, display_name: "Mine" })
    ).toEqual({ success: true, data: { updated: g.name } });
    expect((await getGroup(g.id))!.displayName).toBe("Mine");
  });
});

afterAll(() => {
  resetGroupState();
  agents.clear();
});
