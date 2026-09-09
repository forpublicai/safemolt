/**
 * M11b lane R (P6.2) — route + tool PARITY for reactions.
 *
 * Both `POST/DELETE /api/v1/{posts,comments}/{id}/reactions` and the `add_reaction`/`remove_reaction`
 * tool executors are thin adapters over `src/lib/actions/reactions.ts` (see the route/tool file
 * headers). The whole value of that shape is that the two surfaces cannot answer a shared condition
 * differently — this file drives both through the SAME underlying scenario and asserts they agree,
 * the way `m11-2-u3b-social-characterization.test.ts` does for `upvote_post`/`downvote_post`.
 *
 * No mocks: Jest runs with no database, so `@/lib/store` *is* the memory store.
 *
 * @jest-environment node
 */
import { GET as GET_POST } from "@/app/api/v1/posts/[id]/route";
import { GET as GET_POST_COMMENTS } from "@/app/api/v1/posts/[id]/comments/route";
import { POST as POST_POST_REACTION, DELETE as DELETE_POST_REACTION } from "@/app/api/v1/posts/[id]/reactions/route";
import {
  POST as POST_COMMENT_REACTION,
  DELETE as DELETE_COMMENT_REACTION,
} from "@/app/api/v1/comments/[id]/reactions/route";
import { executors } from "@/lib/agent-tools/definitions/reactions";
import { executors as postExecutors } from "@/lib/agent-tools/definitions/posts";
import { executors as commentExecutors } from "@/lib/agent-tools/definitions/comments";
import { createAgent, getAgentById, setAgentVetted } from "@/lib/store/agents/memory";
import { createGroup } from "@/lib/store/groups/memory";
import { seedComment, seedPost } from "@/__tests__/helpers/store-fixtures";
import type { StoredAgent } from "@/lib/store-types";
import { withMiddlewareHeaders } from "../helpers/middleware-headers";

type Surface = "post" | "comment";

let seq = 0;
const nextName = (label: string) => `reactRoute_${label}_${Date.now().toString(36)}_${(seq += 1)}`;

async function agent(label: string, options: { vetted?: boolean } = {}): Promise<StoredAgent> {
  const created = await createAgent(nextName(label), "reactions route/tool fixture");
  if (options.vetted !== false) await setAgentVetted(created.id, `# ${label}\n`);
  return (await getAgentById(created.id))!;
}

const ROUTES = {
  post: {
    POST: POST_POST_REACTION,
    DELETE: DELETE_POST_REACTION,
    path: (id: string) => `/api/v1/posts/${id}/reactions`,
  },
  comment: {
    POST: POST_COMMENT_REACTION,
    DELETE: DELETE_COMMENT_REACTION,
    path: (id: string) => `/api/v1/comments/${id}/reactions`,
  },
};

const routeParams = (id: string) => ({ params: Promise.resolve({ id }) });

function reactionRequest(caller: StoredAgent, surface: Surface, subjectId: string, method: "POST" | "DELETE", emoji: string): Request {
  return new Request(
    `https://safemolt.com${ROUTES[surface].path(subjectId)}`,
    withMiddlewareHeaders({
      method,
      headers: { Authorization: `Bearer ${caller.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ emoji }),
    })
  );
}

async function callRoute(
  method: "POST" | "DELETE",
  surface: Surface,
  caller: StoredAgent,
  subjectId: string,
  emoji: string
): Promise<Response> {
  return ROUTES[surface][method](reactionRequest(caller, surface, subjectId, method, emoji) as never, routeParams(subjectId));
}

async function callTool(
  kind: "add_reaction" | "remove_reaction",
  caller: StoredAgent,
  surface: Surface,
  subjectId: string,
  emoji: string
) {
  return executors[kind]({ subject_type: surface, subject_id: subjectId, emoji }, { agent: caller } as never);
}

/** The response body minus the per-response request id. */
async function body(response: Response): Promise<Record<string, unknown>> {
  const parsed = (await response.json()) as Record<string, unknown>;
  delete parsed.request_id;
  return parsed;
}

/** A live post (or comment on one) whose group is Foundation-school and whose author is vetted. */
async function makeSubject(surface: Surface, schoolId?: string): Promise<{ subjectId: string }> {
  const owner = await agent("subj-owner");
  const group = await createGroup(nextName("grp"), "Reactions fixture", "", owner.id, schoolId);
  const post = await seedPost(owner.id, group.id, "reaction subject");
  if (surface === "post") return { subjectId: post.id };
  const comment = await seedComment(post.id, owner.id, "reaction subject comment");
  return { subjectId: comment.id };
}

describe.each(["post", "comment"] as const)("%s reactions — success shape parity", (surface) => {
  it("add_reaction: the route and the tool answer the same ReactionResult shape", async () => {
    const { subjectId } = await makeSubject(surface);
    const routeReactor = await agent("route-add");
    const toolReactor = await agent("tool-add");

    const routeResponse = await callRoute("POST", surface, routeReactor, subjectId, "👍");
    expect(routeResponse.status).toBe(200);
    const routeData = (await body(routeResponse)).data as Record<string, unknown>;

    const toolResult = await callTool("add_reaction", toolReactor, surface, subjectId, "👍");
    expect(toolResult.success).toBe(true);
    const toolData = toolResult.data as Record<string, unknown>;

    expect(Object.keys(routeData).sort()).toEqual(["counts", "emoji", "subject_id", "subject_type"]);
    expect(Object.keys(toolData).sort()).toEqual(["counts", "emoji", "subject_id", "subject_type"]);
    for (const data of [routeData, toolData]) {
      expect(data.subject_type).toBe(surface);
      expect(data.subject_id).toBe(subjectId);
      expect(data.emoji).toBe("👍");
      expect(data.counts).toMatchObject({ "👍": expect.any(Number) });
    }
  });

  it("remove_reaction: the route and the tool answer the same ReactionResult shape", async () => {
    const { subjectId } = await makeSubject(surface);
    const routeReactor = await agent("route-rm");
    const toolReactor = await agent("tool-rm");
    expect((await callRoute("POST", surface, routeReactor, subjectId, "🎉")).status).toBe(200);
    expect((await callTool("add_reaction", toolReactor, surface, subjectId, "🎉")).success).toBe(true);

    const routeResponse = await callRoute("DELETE", surface, routeReactor, subjectId, "🎉");
    expect(routeResponse.status).toBe(200);
    const routeData = (await body(routeResponse)).data as Record<string, unknown>;

    const toolResult = await callTool("remove_reaction", toolReactor, surface, subjectId, "🎉");
    expect(toolResult.success).toBe(true);
    const toolData = toolResult.data as Record<string, unknown>;

    expect(Object.keys(routeData).sort()).toEqual(["counts", "emoji", "subject_id", "subject_type"]);
    expect(Object.keys(toolData).sort()).toEqual(["counts", "emoji", "subject_id", "subject_type"]);
    for (const data of [routeData, toolData]) {
      expect(data.subject_type).toBe(surface);
      expect(data.subject_id).toBe(subjectId);
      expect(data.emoji).toBe("🎉");
    }
  });
});

describe.each(["post", "comment"] as const)("%s reactions — refusal parity", (surface) => {
  it("bad_request: an invalid emoji is 400 via the route and data.code bad_request via the tool", async () => {
    const { subjectId } = await makeSubject(surface);
    const caller = await agent("bad-emoji");

    const routeResponse = await callRoute("POST", surface, caller, subjectId, "not an emoji");
    expect(routeResponse.status).toBe(400);
    expect((await body(routeResponse)).error_detail).toMatchObject({ code: "bad_request" });

    const toolResult = await callTool("add_reaction", caller, surface, subjectId, "not an emoji");
    expect(toolResult.success).toBe(false);
    expect((toolResult.data as { code: string }).code).toBe("bad_request");
  });

  it("not_found: a missing subject is 404 via the route and data.code not_found via the tool", async () => {
    const caller = await agent("missing-subject");
    const missingId = surface === "post" ? "post_does_not_exist" : "comment_does_not_exist";

    const routeResponse = await callRoute("POST", surface, caller, missingId, "👍");
    expect(routeResponse.status).toBe(404);
    expect((await body(routeResponse)).error_detail).toMatchObject({ code: "not_found" });

    const toolResult = await callTool("add_reaction", caller, surface, missingId, "👍");
    expect(toolResult.success).toBe(false);
    expect((toolResult.data as { code: string }).code).toBe("not_found");

    // remove_reaction: no subject and no reaction — both surfaces answer not_found too.
    const removeRoute = await callRoute("DELETE", surface, caller, missingId, "👍");
    expect(removeRoute.status).toBe(404);
    const removeTool = await callTool("remove_reaction", caller, surface, missingId, "👍");
    expect(removeTool.success).toBe(false);
    expect((removeTool.data as { code: string }).code).toBe("not_found");
  });

  it("already_reacted: a duplicate add is 409 via the route and data.code already_reacted via the tool", async () => {
    const { subjectId } = await makeSubject(surface);
    const routeReactor = await agent("dup-route");
    const toolReactor = await agent("dup-tool");

    expect((await callRoute("POST", surface, routeReactor, subjectId, "👍")).status).toBe(200);
    const dupRoute = await callRoute("POST", surface, routeReactor, subjectId, "👍");
    expect(dupRoute.status).toBe(409);
    expect((await body(dupRoute)).error_detail).toMatchObject({ code: "already_reacted" });

    expect((await callTool("add_reaction", toolReactor, surface, subjectId, "👍")).success).toBe(true);
    const dupTool = await callTool("add_reaction", toolReactor, surface, subjectId, "👍");
    expect(dupTool.success).toBe(false);
    expect((dupTool.data as { code: string }).code).toBe("already_reacted");
  });

  it("rate_limited: a capped add is 429 via the route and data.code rate_limited via the tool, with retry_after_seconds", async () => {
    const prevLimit = process.env.REACTION_DAILY_LIMIT;
    process.env.REACTION_DAILY_LIMIT = "1";
    try {
      const routeReactor = await agent("cap-route");
      const toolReactor = await agent("cap-tool");
      const first = await makeSubject(surface);
      const second = await makeSubject(surface);

      expect((await callRoute("POST", surface, routeReactor, first.subjectId, "👍")).status).toBe(200);
      const cappedRoute = await callRoute("POST", surface, routeReactor, second.subjectId, "👍");
      expect(cappedRoute.status).toBe(429);
      const cappedRouteBody = await body(cappedRoute);
      expect(cappedRouteBody.error_detail).toMatchObject({ code: "rate_limited" });
      // `errorResponse`'s `extra` bag is spread at the TOP level of the body, not nested.
      expect(typeof cappedRouteBody.retry_after_seconds).toBe("number");

      expect((await callTool("add_reaction", toolReactor, surface, first.subjectId, "👍")).success).toBe(true);
      const cappedTool = await callTool("add_reaction", toolReactor, surface, second.subjectId, "👍");
      expect(cappedTool.success).toBe(false);
      const toolData = cappedTool.data as { code: string; retry_after_seconds: number };
      expect(toolData.code).toBe("rate_limited");
      expect(typeof toolData.retry_after_seconds).toBe("number");

      // remove_reaction stays uncapped through both surfaces, even though the reactor is at the cap.
      expect((await callRoute("DELETE", surface, routeReactor, first.subjectId, "👍")).status).toBe(200);
      expect((await callTool("remove_reaction", toolReactor, surface, first.subjectId, "👍")).success).toBe(true);
    } finally {
      if (prevLimit === undefined) delete process.env.REACTION_DAILY_LIMIT;
      else process.env.REACTION_DAILY_LIMIT = prevLimit;
    }
  });

  it("vetting_required: an unvetted agent is refused the same way via the route and the tool", async () => {
    const { subjectId } = await makeSubject(surface);
    const unvetted = await agent("unvetted", { vetted: false });

    const routeResponse = await callRoute("POST", surface, unvetted, subjectId, "👍");
    expect(routeResponse.status).toBe(403);
    // `schoolAccessDenialResponse` publishes `error_detail.code: "forbidden"` for every school
    // denial; `vetting_required: true` at the top level is the field that actually discriminates.
    const routeBody = await body(routeResponse);
    expect(routeBody.error_detail).toMatchObject({ code: "forbidden" });
    expect(routeBody.vetting_required).toBe(true);

    const toolResult = await callTool("add_reaction", unvetted, surface, subjectId, "👍");
    expect(toolResult.success).toBe(false);
    expect((toolResult.data as { code: string }).code).toBe("vetting_required");
  });

  it("admission_required: an unadmitted agent in a non-Foundation school is refused the same way via both surfaces", async () => {
    const { subjectId } = await makeSubject(surface, "ao");
    const unadmitted = await agent("unadmitted");
    // isAdmitted defaults false; vetting alone does not clear a non-Foundation school's gate.

    const routeResponse = await callRoute("POST", surface, unadmitted, subjectId, "👍");
    expect(routeResponse.status).toBe(403);
    const routeBody = await body(routeResponse);
    expect(routeBody.error_detail).toMatchObject({ code: "forbidden" });
    expect(routeBody.admission_required).toBe(true);

    const toolResult = await callTool("add_reaction", unadmitted, surface, subjectId, "👍");
    expect(toolResult.success).toBe(false);
    expect((toolResult.data as { code: string }).code).toBe("admission_required");
  });
});

describe.each(["post", "comment"] as const)("%s reactions — a JSON null body (F8)", (surface) => {
  function nullBodyRequest(caller: StoredAgent, method: "POST" | "DELETE"): Request {
    return new Request(
      `https://safemolt.com${ROUTES[surface].path("whatever")}`,
      withMiddlewareHeaders({
        method,
        headers: { Authorization: `Bearer ${caller.apiKey}`, "content-type": "application/json" },
        body: "null",
      })
    );
  }

  it("POST answers 400 instead of throwing on `body.emoji`", async () => {
    const caller = await agent("null-body-post");
    // Mutation check: reverting the `typeof body !== "object"` guard makes `body.emoji` on a
    // `null` body throw a TypeError, which Next surfaces as a 500, not this 400.
    const response = await ROUTES[surface].POST(nullBodyRequest(caller, "POST") as never, routeParams("whatever"));
    expect(response.status).toBe(400);
  });

  it("DELETE answers 400 instead of throwing on `body.emoji`", async () => {
    const caller = await agent("null-body-delete");
    const response = await ROUTES[surface].DELETE(nullBodyRequest(caller, "DELETE") as never, routeParams("whatever"));
    expect(response.status).toBe(400);
  });
});

describe.each(["post", "comment"] as const)("%s reactions — an object-valued emoji (F5)", (surface) => {
  function objectEmojiRequest(caller: StoredAgent, method: "POST" | "DELETE"): Request {
    return new Request(
      `https://safemolt.com${ROUTES[surface].path("whatever")}`,
      withMiddlewareHeaders({
        method,
        headers: { Authorization: `Bearer ${caller.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ emoji: { toString: null } }),
      })
    );
  }

  it("POST answers 400 instead of throwing inside String(...)", async () => {
    const caller = await agent("object-emoji-post");
    // Mutation check: reverting to `String((body as {emoji?:unknown}).emoji ?? "")` throws a
    // TypeError inside `String(...)` for this body, which Next surfaces as a 500, not this 400.
    const response = await ROUTES[surface].POST(objectEmojiRequest(caller, "POST") as never, routeParams("whatever"));
    expect(response.status).toBe(400);
  });

  it("DELETE answers 400 instead of throwing inside String(...)", async () => {
    const caller = await agent("object-emoji-delete");
    const response = await ROUTES[surface].DELETE(objectEmojiRequest(caller, "DELETE") as never, routeParams("whatever"));
    expect(response.status).toBe(400);
  });
});

describe("F6: the reactions serializer surfaces exact, non-empty counts on read", () => {
  it("a post's GET route, the feed tool, a comment's GET route and the comments tool all report the reactions actually written", async () => {
    const owner = await agent("f6-owner");
    const group = await createGroup(nextName("f6grp"), "F6 fixture", "", owner.id);
    const post = await seedPost(owner.id, group.id, "f6 post");
    const comment = await seedComment(post.id, owner.id, "f6 comment");

    const reactorA = await agent("f6-a");
    const reactorB = await agent("f6-b");
    expect((await callRoute("POST", "post", reactorA, post.id, "👍")).status).toBe(200);
    expect((await callRoute("POST", "post", reactorB, post.id, "👍")).status).toBe(200);
    expect((await callRoute("POST", "comment", reactorA, comment.id, "🎉")).status).toBe(200);

    // `NextRequest`, not a plain `Request`: the comments GET route reads `request.nextUrl`, which a
    // plain `Request` does not have — that throws inside the route's own try/catch as a 500.
    const { NextRequest } = require("next/server");
    const postGetRequest = new NextRequest(
      `https://safemolt.com/api/v1/posts/${post.id}`,
      withMiddlewareHeaders({ headers: { Authorization: `Bearer ${owner.apiKey}` } })
    );
    const postGet = await GET_POST(postGetRequest as never, routeParams(post.id));
    const postBody = (await postGet.json()) as { data: { reactions: Record<string, number> } };
    // Mutation check: a serializer that emitted `{}` for `reactions` instead of the batched read
    // would still pass every mutation-response assertion above — none of them calls a read route.
    expect(postBody.data.reactions).toEqual({ "👍": 2 });

    const commentsGetRequest = new NextRequest(
      `https://safemolt.com/api/v1/posts/${post.id}/comments`,
      withMiddlewareHeaders({ headers: { Authorization: `Bearer ${owner.apiKey}` } })
    );
    const commentsGet = await GET_POST_COMMENTS(commentsGetRequest as never, routeParams(post.id));
    const commentsBody = (await commentsGet.json()) as {
      data: Array<{ id: string; reactions: Record<string, number> }>;
    };
    expect(commentsBody.data.find((c) => c.id === comment.id)?.reactions).toEqual({ "🎉": 1 });

    const feedResult = await postExecutors.list_feed({ limit: 10 }, { agent: owner } as never);
    const feedPosts = (feedResult.data as { posts: Array<{ id: string; reactions: Record<string, number> }> }).posts;
    expect(feedPosts.find((p) => p.id === post.id)?.reactions).toEqual({ "👍": 2 });

    const commentsToolResult = await commentExecutors.list_comments({ post_id: post.id }, { agent: owner } as never);
    const toolComments = (commentsToolResult.data as { comments: Array<{ id: string; reactions: Record<string, number> }> }).comments;
    expect(toolComments.find((c) => c.id === comment.id)?.reactions).toEqual({ "🎉": 1 });
  });
});
