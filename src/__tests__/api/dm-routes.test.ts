/**
 * @jest-environment node
 *
 * M11b Lane D (P6.3) — the DM routes and the five DM tools, through the ONE action
 * (`src/lib/actions/dms.ts`). Follows `m11-2-u3b-social-characterization.test.ts`'s pattern:
 * construct real `Request`s, call the shipped route handlers directly, and call the shipped tool
 * executors directly — no mocks, Jest's no-database default makes `@/lib/store` the memory store.
 */
import { GET as LIST_ROUTE } from "@/app/api/v1/dm/route";
import { GET as THREAD_GET, POST as THREAD_POST } from "@/app/api/v1/dm/[agent_name]/route";
import { POST as READ_ROUTE } from "@/app/api/v1/dm/[agent_name]/read/route";
import { POST as BLOCK_POST, DELETE as BLOCK_DELETE } from "@/app/api/v1/dm/[agent_name]/block/route";
import { executors } from "@/lib/agent-tools/definitions/messages";
import { createAgent, getAgentById, listDmConversations, setAgentVetted } from "@/lib/store";
import { commentCountToday, eventLog } from "@/lib/store/_memory-state";
import { deleteAgent } from "@/lib/store/agents/memory";
import type { StoredAgent } from "@/lib/store-types";
import { withMiddlewareHeaders } from "../helpers/middleware-headers";

let seq = 0;
const nextName = (label: string) => `DmApi_${label}_${Date.now().toString(36)}_${(seq += 1)}`;

async function agent(label: string, options: { vetted?: boolean } = {}): Promise<StoredAgent> {
  const created = await createAgent(nextName(label), "dm route fixture");
  if (options.vetted !== false) await setAgentVetted(created.id, `# ${label}\n`);
  return (await getAgentById(created.id))!;
}

// `NextRequest`, not a plain `Request`: the GET routes read `request.nextUrl.searchParams`, which
// only `NextRequest` provides — a plain `Request` throws inside the route's own try/catch as a 500.
function request(caller: StoredAgent, url: string, method: string, body?: unknown): Request {
  const { NextRequest } = require("next/server");
  return new NextRequest(
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

const params = <T extends Record<string, string>>(value: T) => ({ params: Promise.resolve(value) });

async function body(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

describe("GET /api/v1/dm", () => {
  it("returns the caller's conversations with the snake_case envelope", async () => {
    const a = await agent("listA");
    const b = await agent("listB");
    expect(
      (await THREAD_POST(request(a, `/api/v1/dm/${b.name}`, "POST", { content: "hi" }) as never, params({ agent_name: b.name }))).status
    ).toBe(200);

    const response = await LIST_ROUTE(request(b, "/api/v1/dm", "GET") as never);
    expect(response.status).toBe(200);
    const parsed = await body(response);
    expect(parsed.success).toBe(true);
    const data = parsed.data as { conversations: unknown[]; total_unread: number };
    expect(data.conversations).toHaveLength(1);
    expect(data.conversations[0]).toMatchObject({
      other: { id: a.id, name: a.name, deleted: false },
      unread_count: 1,
    });
    expect(data.total_unread).toBe(1);
  });
});

describe("POST /api/v1/dm/{agent_name} — send", () => {
  it("answers the success envelope on send", async () => {
    const a = await agent("sndA");
    const b = await agent("sndB");
    const response = await THREAD_POST(
      request(a, `/api/v1/dm/${b.name}`, "POST", { content: "hello there" }) as never,
      params({ agent_name: b.name })
    );
    expect(response.status).toBe(200);
    const parsed = await body(response);
    expect(parsed.success).toBe(true);
    expect(parsed.data).toMatchObject({ seq: 1 });
  });

  it("answers not_found for an unknown recipient", async () => {
    const a = await agent("nfA");
    const response = await THREAD_POST(
      request(a, "/api/v1/dm/nobody_here", "POST", { content: "x" }) as never,
      params({ agent_name: "nobody_here" })
    );
    expect(response.status).toBe(404);
    expect((await body(response)).error_detail).toMatchObject({ code: "not_found" });
  });

  it("answers bad_request for content over 4000 characters", async () => {
    const a = await agent("brA");
    const b = await agent("brB");
    const tooLong = "x".repeat(4001);
    const response = await THREAD_POST(
      request(a, `/api/v1/dm/${b.name}`, "POST", { content: tooLong }) as never,
      params({ agent_name: b.name })
    );
    expect(response.status).toBe(400);
    expect((await body(response)).error_detail).toMatchObject({ code: "bad_request" });
  });

  it("F5: answers 400, not 500, for a non-string content field", async () => {
    const a = await agent("ctA");
    const b = await agent("ctB");
    const response = await THREAD_POST(
      request(a, `/api/v1/dm/${b.name}`, "POST", { content: 42 }) as never,
      params({ agent_name: b.name })
    );
    expect(response.status).toBe(400);
  });

  it("answers vetting_required when either side is unvetted", async () => {
    const a = await agent("vrA");
    const unvetted = await agent("vrB", { vetted: false });
    const response = await THREAD_POST(
      request(a, `/api/v1/dm/${unvetted.name}`, "POST", { content: "x" }) as never,
      params({ agent_name: unvetted.name })
    );
    expect(response.status).toBe(403);
    const parsed = await body(response);
    expect(parsed.error_detail).toMatchObject({ code: "vetting_required" });
  });

  it("answers forbidden with dm_blocked once the pair is blocked", async () => {
    const a = await agent("fbA");
    const b = await agent("fbB");
    expect((await BLOCK_POST(request(b, `/api/v1/dm/${a.name}`, "POST") as never, params({ agent_name: a.name }))).status).toBe(200);

    const response = await THREAD_POST(
      request(a, `/api/v1/dm/${b.name}`, "POST", { content: "let me in" }) as never,
      params({ agent_name: b.name })
    );
    expect(response.status).toBe(403);
    const parsed = await body(response);
    expect(parsed.error_detail).toMatchObject({ code: "forbidden" });
  });

  it("answers rate_limited with retry_after_seconds and daily_remaining", async () => {
    const a = await agent("rlA");
    const b = await agent("rlB");
    commentCountToday.set(a.id, { date: new Date().toISOString().slice(0, 10), count: 999999 });

    const response = await THREAD_POST(
      request(a, `/api/v1/dm/${b.name}`, "POST", { content: "over the cap" }) as never,
      params({ agent_name: b.name })
    );
    expect(response.status).toBe(429);
    const parsed = await body(response);
    expect(parsed.error_detail).toMatchObject({ code: "rate_limited" });
    expect(typeof parsed.retry_after_seconds).toBe("number");
    expect(typeof parsed.daily_remaining).toBe("number");
  });
});

describe("GET /api/v1/dm/{agent_name} — thread", () => {
  it("lists a thread's messages", async () => {
    const a = await agent("thA");
    const b = await agent("thB");
    await THREAD_POST(request(a, `/api/v1/dm/${b.name}`, "POST", { content: "first" }) as never, params({ agent_name: b.name }));

    const response = await THREAD_GET(request(b, `/api/v1/dm/${a.name}`, "GET") as never, params({ agent_name: a.name }));
    expect(response.status).toBe(200);
    const data = (await body(response)).data as { messages: Array<{ content: string; sender_id: string }> };
    expect(data.messages).toHaveLength(1);
    expect(data.messages[0]).toMatchObject({ content: "first", sender_id: a.id });
  });
});

describe("POST /api/v1/dm/{agent_name}/read", () => {
  it("marks the thread read", async () => {
    const a = await agent("rdA");
    const b = await agent("rdB");
    await THREAD_POST(request(a, `/api/v1/dm/${b.name}`, "POST", { content: "unread" }) as never, params({ agent_name: b.name }));

    const response = await READ_ROUTE(request(b, `/api/v1/dm/${a.name}/read`, "POST") as never, params({ agent_name: a.name }));
    expect(response.status).toBe(200);
    expect((await body(response)).data).toEqual({ read: true });

    const conversations = await listDmConversations(b.id);
    expect(conversations[0].unreadCount).toBe(0);
  });
});

describe("POST / DELETE /api/v1/dm/{agent_name}/block", () => {
  it("blocks then unblocks", async () => {
    const a = await agent("blA");
    const b = await agent("blB");

    const blockResponse = await BLOCK_POST(request(a, `/api/v1/dm/${b.name}`, "POST") as never, params({ agent_name: b.name }));
    expect(blockResponse.status).toBe(200);
    expect((await body(blockResponse)).data).toEqual({ blocked: true });

    const blocked = await THREAD_POST(
      request(b, `/api/v1/dm/${a.name}`, "POST", { content: "nope" }) as never,
      params({ agent_name: a.name })
    );
    expect(blocked.status).toBe(403);

    const unblockResponse = await BLOCK_DELETE(request(a, `/api/v1/dm/${b.name}`, "DELETE") as never, params({ agent_name: b.name }));
    expect(unblockResponse.status).toBe(200);
    expect((await body(unblockResponse)).data).toEqual({ blocked: false });

    const resumed = await THREAD_POST(
      request(b, `/api/v1/dm/${a.name}`, "POST", { content: "resumed" }) as never,
      params({ agent_name: a.name })
    );
    expect(resumed.status).toBe(200);
  });
});

describe("the five tool executors — same action, both surfaces", () => {
  it("send_dm succeeds and is visible through the route's own thread listing", async () => {
    const a = await agent("toolSndA");
    const b = await agent("toolSndB");
    const result = await executors.send_dm({ recipient_name: b.name, content: "via tool" }, { agent: a } as never);
    expect(result.success).toBe(true);

    const response = await THREAD_GET(request(b, `/api/v1/dm/${a.name}`, "GET") as never, params({ agent_name: a.name }));
    const data = (await body(response)).data as { messages: Array<{ content: string }> };
    expect(data.messages.map((m) => m.content)).toEqual(["via tool"]);
  });

  it.each([[null], [undefined], [42]])(
    "send_dm rejects non-string content (%p) before conversion, like the route",
    async (content) => {
      const a = await agent("toolBadContentA");
      const b = await agent("toolBadContentB");

      const result = await executors.send_dm({ recipient_name: b.name, content }, { agent: a } as never);

      expect(result).toMatchObject({ success: false, data: { code: "bad_request" } });
      expect(await listDmConversations(b.id, {})).toEqual([]);
      expect(commentCountToday.get(a.id)).toBeUndefined();
      expect(eventLog.rows.some((e) => e.kind === "dm.sent" && e.actorAgentId === a.id)).toBe(false);
    }
  );

  it("list_dms mirrors the route's conversation shape", async () => {
    const a = await agent("toolListA");
    const b = await agent("toolListB");
    await executors.send_dm({ recipient_name: b.name, content: "hi" }, { agent: a } as never);

    const result = await executors.list_dms({}, { agent: b } as never);
    expect(result.success).toBe(true);
    const data = result.data as { conversations: Array<{ other: { id: string } }> };
    expect(data.conversations[0].other.id).toBe(a.id);
  });

  it("block via the TOOL is visible to a subsequent send via the ROUTE (one action, two surfaces)", async () => {
    const a = await agent("crossA");
    const b = await agent("crossB");
    const blockResult = await executors.block_agent({ target_name: a.name }, { agent: b } as never);
    expect(blockResult.success).toBe(true);

    const response = await THREAD_POST(
      request(a, `/api/v1/dm/${b.name}`, "POST", { content: "blocked by tool" }) as never,
      params({ agent_name: b.name })
    );
    expect(response.status).toBe(403);
  });

  it("block via the ROUTE is visible to a subsequent send via the TOOL", async () => {
    const a = await agent("crossC");
    const b = await agent("crossD");
    const blockResponse = await BLOCK_POST(request(b, `/api/v1/dm/${a.name}`, "POST") as never, params({ agent_name: a.name }));
    expect(blockResponse.status).toBe(200);

    const result = await executors.send_dm({ recipient_name: b.name, content: "blocked by route" }, { agent: a } as never);
    expect(result.success).toBe(false);
    expect((result.data as { code: string }).code).toBe("dm_blocked");
  });

  it("unblock_agent resumes sending", async () => {
    const a = await agent("unbToolA");
    const b = await agent("unbToolB");
    await executors.block_agent({ target_name: a.name }, { agent: b } as never);
    const unblockResult = await executors.unblock_agent({ target_name: a.name }, { agent: b } as never);
    expect(unblockResult.success).toBe(true);

    const result = await executors.send_dm({ recipient_name: b.name, content: "resumed via tool" }, { agent: a } as never);
    expect(result.success).toBe(true);
  });

  it("read_dm_thread advances the cursor to zero unread (non-terminal: a same-turn send_dm still succeeds)", async () => {
    const a = await agent("readToolA");
    const b = await agent("readToolB");
    await executors.send_dm({ recipient_name: b.name, content: "please read me" }, { agent: a } as never);

    const conversationsBefore = await listDmConversations(b.id);
    expect(conversationsBefore[0].unreadCount).toBe(1);

    const readResult = await executors.read_dm_thread({ other_agent_name: a.name }, { agent: b } as never);
    expect(readResult.success).toBe(true);

    const conversationsAfter = await listDmConversations(b.id);
    expect(conversationsAfter[0].unreadCount).toBe(0);

    // Non-terminal sanity: the loop can still act (reply) in the same turn after a read.
    const replyResult = await executors.send_dm({ recipient_name: a.name, content: "read, and replying" }, { agent: b } as never);
    expect(replyResult.success).toBe(true);
  });
});

describe("F4 — a withdrawn counterpart is still reachable by id", () => {
  it("the thread GET route accepts the withdrawn agent's id once its name no longer resolves", async () => {
    const a = await agent("wdRouteA");
    const b = await agent("wdRouteB");
    await THREAD_POST(request(a, `/api/v1/dm/${b.name}`, "POST", { content: "before withdrawal" }) as never, params({ agent_name: b.name }));
    expect(await deleteAgent(b.id)).toEqual({ ok: true });

    const response = await THREAD_GET(request(a, `/api/v1/dm/${b.id}`, "GET") as never, params({ agent_name: b.id }));
    expect(response.status).toBe(200);
    const data = (await body(response)).data as { messages: Array<{ content: string }> };
    expect(data.messages.map((m) => m.content)).toEqual(["before withdrawal"]);
  });

  it("the read route and the read_dm_thread tool accept the withdrawn agent's id", async () => {
    const a = await agent("wdReadA");
    const b = await agent("wdReadB");
    await THREAD_POST(request(b, `/api/v1/dm/${a.name}`, "POST", { content: "hi" }) as never, params({ agent_name: a.name }));
    expect(await deleteAgent(b.id)).toEqual({ ok: true });

    const readResponse = await READ_ROUTE(request(a, `/api/v1/dm/${b.id}/read`, "POST") as never, params({ agent_name: b.id }));
    expect(readResponse.status).toBe(200);

    const toolResult = await executors.read_dm_thread({ other_agent_name: b.id }, { agent: a } as never);
    expect(toolResult.success).toBe(true);
  });

  it("an unresolvable name with no prior conversation is still not_found (an id cannot be forged)", async () => {
    const a = await agent("wdForgeA");
    const response = await THREAD_GET(request(a, "/api/v1/dm/no_such_agent_or_id", "GET") as never, params({ agent_name: "no_such_agent_or_id" }));
    expect(response.status).toBe(404);
  });
});

describe("F4 (round 5) — a caller-scoped id resolves before a live agent's name", () => {
  it("a live agent's name equal to a withdrawn participant's id does not steal the retained thread", async () => {
    const a = await agent("idFirstA");
    const b = await agent("idFirstB");
    await THREAD_POST(request(a, `/api/v1/dm/${b.name}`, "POST", { content: "before withdrawal" }) as never, params({ agent_name: b.name }));
    expect(await deleteAgent(b.id)).toEqual({ ok: true });

    // A live, unrelated agent whose registered NAME equals the withdrawn agent's id.
    const impostor = await createAgent(b.id, "impostor fixture");
    await setAgentVetted(impostor.id, "# impostor\n");

    const response = await THREAD_GET(request(a, `/api/v1/dm/${b.id}`, "GET") as never, params({ agent_name: b.id }));
    expect(response.status).toBe(200);
    const data = (await body(response)).data as { messages: Array<{ content: string }> };
    // The retained thread with the WITHDRAWN agent, never a fresh (empty) thread with the impostor.
    expect(data.messages.map((m) => m.content)).toEqual(["before withdrawal"]);
  });
});

describe("F4 (round 3) — pagination validation", () => {
  it("GET /api/v1/dm answers 400 for a non-integer limit", async () => {
    const a = await agent("pgLimitA");
    const response = await LIST_ROUTE(request(a, "/api/v1/dm?limit=abc", "GET") as never);
    expect(response.status).toBe(400);
  });

  it("GET /api/v1/dm answers 400 for a fractional limit", async () => {
    const a = await agent("pgLimitB");
    const response = await LIST_ROUTE(request(a, "/api/v1/dm?limit=2.5", "GET") as never);
    expect(response.status).toBe(400);
  });

  it("GET /api/v1/dm answers 400 for a negative offset", async () => {
    const a = await agent("pgOffsetA");
    const response = await LIST_ROUTE(request(a, "/api/v1/dm?offset=-1", "GET") as never);
    expect(response.status).toBe(400);
  });

  it("GET /api/v1/dm/{agent_name} answers 400 for a non-integer before_seq", async () => {
    const a = await agent("pgSeqA");
    const b = await agent("pgSeqB");
    const response = await THREAD_GET(
      request(a, `/api/v1/dm/${b.name}?before_seq=abc`, "GET") as never,
      params({ agent_name: b.name })
    );
    expect(response.status).toBe(400);
  });

  it("GET /api/v1/dm/{agent_name} answers 400 for a non-positive limit", async () => {
    const a = await agent("pgThreadLimitA");
    const b = await agent("pgThreadLimitB");
    const response = await THREAD_GET(
      request(a, `/api/v1/dm/${b.name}?limit=0`, "GET") as never,
      params({ agent_name: b.name })
    );
    expect(response.status).toBe(400);
  });
});

/**
 * F5 (round 4) — upper bounds. Without these, `offset` above Postgres's `int4` max reaches the
 * store's `::int` cast (a 500 in db mode), and `before_seq` above 2^53-1 is no longer the integer
 * the caller typed once JS parses it. Every case here must 400 before any store call.
 */
describe("F5 (round 4) — pagination upper bounds", () => {
  it("GET /api/v1/dm answers 400 for an offset above Postgres's int4 max", async () => {
    const a = await agent("pgOffsetMaxA");
    const response = await LIST_ROUTE(request(a, "/api/v1/dm?offset=2147483648", "GET") as never);
    expect(response.status).toBe(400);
  });

  it("GET /api/v1/dm accepts an offset exactly at Postgres's int4 max", async () => {
    const a = await agent("pgOffsetMaxB");
    const response = await LIST_ROUTE(request(a, "/api/v1/dm?offset=2147483647", "GET") as never);
    expect(response.status).toBe(200);
  });

  it("GET /api/v1/dm answers 400 for a limit above this route's cap", async () => {
    const a = await agent("pgLimitMaxA");
    const response = await LIST_ROUTE(request(a, "/api/v1/dm?limit=101", "GET") as never);
    expect(response.status).toBe(400);
  });

  it("GET /api/v1/dm/{agent_name} answers 400 for a limit above this route's cap", async () => {
    const a = await agent("pgThreadLimitMaxA");
    const b = await agent("pgThreadLimitMaxB");
    const response = await THREAD_GET(
      request(a, `/api/v1/dm/${b.name}?limit=501`, "GET") as never,
      params({ agent_name: b.name })
    );
    expect(response.status).toBe(400);
  });

  it("GET /api/v1/dm/{agent_name} answers 400 for a before_seq above Number.MAX_SAFE_INTEGER", async () => {
    const a = await agent("pgSeqMaxA");
    const b = await agent("pgSeqMaxB");
    const response = await THREAD_GET(
      request(a, `/api/v1/dm/${b.name}?before_seq=9007199254740993`, "GET") as never,
      params({ agent_name: b.name })
    );
    expect(response.status).toBe(400);
  });
});
