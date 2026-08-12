/**
 * M11-2 u3 — CHARACTERIZATION. The exact wire shapes the post surfaces answer with **today**.
 *
 * P1.1 turns four route handlers and four tool executors into adapters over
 * `src/lib/actions/posts.ts`. The whole value of that refactor depends on nothing an agent can
 * observe changing, and "nothing changed" is not a claim a diff can make: the route bodies are
 * assembled from `errorResponse`'s envelope, the school gate's own envelope, and hand-written
 * hints, and the tool bodies are a third shape again. So every one of them is pinned here, field
 * for field, **before** the refactor — and this file is then re-run against the adapters.
 *
 * Deliberately whole-body assertions rather than status codes: a refactor that preserved the status
 * and dropped `hint`, or renamed `retry_after_minutes`, would pass a status-only gate while breaking
 * every client that reads the field.
 *
 * **Every pin below was derived from the PRE-u3 source, at `HEAD@a7f4cd3b`**, and re-verified against
 * it branch for branch: `git show a7f4cd3b:src/app/api/v1/posts/route.ts`, `…/[id]/route.ts`,
 * `…/[id]/pin/route.ts` and `…/src/lib/agent-tools/definitions/posts.ts` (u3 is uncommitted, so HEAD
 * is still the code these pins describe). That provenance matters: a characterization suite written
 * by reading the *refactored* code proves the refactor is self-consistent and nothing more. Every
 * string, status and field name here appears verbatim in that revision.
 *
 * **One behavior changed on purpose**, and it has its own test at the bottom rather than a silently
 * adjusted pin: the `delete_post` tool now checks authorship before the school rule.
 *
 * `request_id` and `X-Request-Id` are generated per response and are the only fields excluded.
 *
 * No mocks: Jest runs with no database, so `@/lib/store` *is* the memory store.
 *
 * @jest-environment node
 */
import { POST as CREATE_POST } from "@/app/api/v1/posts/route";
import { DELETE as DELETE_POST } from "@/app/api/v1/posts/[id]/route";
import { POST as PIN_POST, DELETE as UNPIN_POST } from "@/app/api/v1/posts/[id]/pin/route";
import { executors } from "@/lib/agent-tools/definitions/posts";
import { createAgent, getAgentById, setAgentVetted } from "@/lib/store/agents/memory";
import { createGroup, joinGroup } from "@/lib/store/groups/memory";
import { lastPostAt, posts } from "@/lib/store/_memory-state";
import { seedPost } from "@/__tests__/helpers/store-fixtures";
import type { StoredAgent } from "@/lib/store-types";
import { withMiddlewareHeaders } from "../../helpers/middleware-headers";

let seq = 0;
const nextName = (label: string) => `u3c_${label}_${Date.now().toString(36)}_${(seq += 1)}`;

async function agent(label: string, options: { vetted?: boolean } = {}): Promise<StoredAgent> {
  const created = await createAgent(nextName(label), "u3 characterization fixture");
  if (options.vetted !== false) await setAgentVetted(created.id, `# ${label}\n`);
  return (await getAgentById(created.id))!;
}

async function group(owner: StoredAgent) {
  return createGroup(nextName("grp"), "U3 characterization", "", owner.id);
}

function postRequest(caller: StoredAgent, body: unknown): Request {
  return new Request(
    "https://safemolt.com/api/v1/posts",
    withMiddlewareHeaders({
      method: "POST",
      headers: { Authorization: `Bearer ${caller.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  );
}

function postIdRequest(caller: StoredAgent, postId: string, method: string, suffix = ""): Request {
  return new Request(
    `https://safemolt.com/api/v1/posts/${postId}${suffix}`,
    withMiddlewareHeaders({ method, headers: { Authorization: `Bearer ${caller.apiKey}` } })
  );
}

/** The response body minus the per-response request id. */
async function body(response: Response): Promise<Record<string, unknown>> {
  const parsed = (await response.json()) as Record<string, unknown>;
  delete parsed.request_id;
  return parsed;
}

describe("POST /api/v1/posts — response shapes", () => {
  it("answers the success envelope, with the group NAME and the post's own counters", async () => {
    const author = await agent("author");
    const g = await group(author);
    lastPostAt.clear();

    const response = await CREATE_POST(postRequest(author, { group: g.name, title: " Hello ", content: " body ", url: " https://x.test " }) as never);

    expect(response.status).toBe(200);
    const parsed = await body(response);
    const data = parsed.data as Record<string, unknown>;
    expect(parsed.success).toBe(true);
    // Trimming is part of the contract: the route trims every submitted field.
    expect(data).toEqual({
      id: expect.stringMatching(/^post_/),
      title: "Hello",
      content: "body",
      url: "https://x.test",
      group: g.name,
      upvotes: 0,
      comment_count: 0,
      created_at: expect.any(String),
    });
    // `downvotes` is deliberately absent from the create response, and always has been.
    expect(Object.keys(data).sort()).toEqual(
      ["comment_count", "content", "created_at", "group", "id", "title", "upvotes", "url"]
    );
  });

  it("answers 400 with the bare validation envelope when group or title is missing", async () => {
    const author = await agent("novalidate");
    const response = await CREATE_POST(postRequest(author, { title: "no group" }) as never);

    expect(response.status).toBe(400);
    expect(await body(response)).toEqual({
      success: false,
      error: "group and title are required",
      error_detail: { code: "bad_request", message: "group and title are required" },
    });
  });

  it("answers 404 with the create-it-first hint for an unknown group", async () => {
    const author = await agent("nogroup");
    const response = await CREATE_POST(postRequest(author, { group: "no_such_group", title: "t" }) as never);

    expect(response.status).toBe(404);
    expect(await body(response)).toEqual({
      success: false,
      error: "Group not found",
      hint: "Create it first or use an existing group",
      error_detail: {
        code: "not_found",
        message: "Group not found",
        hint: "Create it first or use an existing group",
      },
    });
  });

  it("answers the school gate's own 403 envelope for an unvetted agent", async () => {
    const owner = await agent("schoolowner");
    const g = await group(owner);
    const unvetted = await agent("unvetted", { vetted: false });
    lastPostAt.clear();

    const response = await CREATE_POST(postRequest(unvetted, { group: g.name, title: "t" }) as never);

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

  it("answers 403 with the join-first hint for a non-member", async () => {
    const owner = await agent("memberowner");
    const g = await group(owner);
    const stranger = await agent("stranger");
    lastPostAt.clear();

    const response = await CREATE_POST(postRequest(stranger, { group: g.name, title: "t" }) as never);

    expect(response.status).toBe(403);
    expect(await body(response)).toEqual({
      success: false,
      error: "Forbidden",
      hint: "You must be a member of this group to post in it. Join first.",
      error_detail: {
        code: "forbidden",
        message: "Forbidden",
        hint: "You must be a member of this group to post in it. Join first.",
      },
    });
  });

  it("answers 429 with retry_after_minutes when the cooldown refuses the insert", async () => {
    const author = await agent("cooldown");
    const g = await group(author);
    lastPostAt.clear();

    expect((await CREATE_POST(postRequest(author, { group: g.name, title: "first" }) as never)).status).toBe(200);
    const refused = await CREATE_POST(postRequest(author, { group: g.name, title: "second" }) as never);

    expect(refused.status).toBe(429);
    expect(await body(refused)).toEqual({
      success: false,
      error: "Post cooldown",
      hint: "Please wait before creating another post.",
      error_detail: {
        code: "rate_limited",
        message: "Post cooldown",
        hint: "Please wait before creating another post.",
      },
      retry_after_minutes: expect.any(Number),
    });
  });
});

describe("DELETE /api/v1/posts/{id} — response shapes", () => {
  it("answers the message envelope on success", async () => {
    const author = await agent("delauthor");
    const g = await group(author);
    const post = await seedPost(author.id, g.id, "delete me");

    const response = await DELETE_POST(postIdRequest(author, post.id, "DELETE") as never, {
      params: Promise.resolve({ id: post.id }),
    });

    expect(response.status).toBe(200);
    expect(await body(response)).toEqual({ success: true, message: "Post deleted" });
  });

  it("answers one 404 for missing, already-deleted, and not-yours alike", async () => {
    const author = await agent("delowner");
    const other = await agent("delother");
    const g = await group(author);
    const post = await seedPost(author.id, g.id, "not yours");
    const expected = {
      success: false,
      error: "Post not found or not authorized to delete",
      error_detail: { code: "not_found", message: "Post not found or not authorized to delete" },
    };

    const missing = await DELETE_POST(postIdRequest(author, "post_nope", "DELETE") as never, {
      params: Promise.resolve({ id: "post_nope" }),
    });
    expect(missing.status).toBe(404);
    expect(await body(missing)).toEqual(expected);

    const notMine = await DELETE_POST(postIdRequest(other, post.id, "DELETE") as never, {
      params: Promise.resolve({ id: post.id }),
    });
    expect(notMine.status).toBe(404);
    expect(await body(notMine)).toEqual(expected);

    posts.get(post.id)!.deletedAt = new Date().toISOString();
    const gone = await DELETE_POST(postIdRequest(author, post.id, "DELETE") as never, {
      params: Promise.resolve({ id: post.id }),
    });
    expect(gone.status).toBe(404);
    expect(await body(gone)).toEqual(expected);
  });
});

describe("POST/DELETE /api/v1/posts/{id}/pin — response shapes", () => {
  it("answers the pinned/unpinned message envelopes", async () => {
    const owner = await agent("pinowner");
    const g = await group(owner);
    const post = await seedPost(owner.id, g.id, "pin me");

    const pinned = await PIN_POST(postIdRequest(owner, post.id, "POST", "/pin") as never, {
      params: Promise.resolve({ id: post.id }),
    });
    expect(pinned.status).toBe(200);
    expect(await body(pinned)).toEqual({ success: true, message: "Post pinned" });

    const unpinned = await UNPIN_POST(postIdRequest(owner, post.id, "DELETE", "/pin") as never, {
      params: Promise.resolve({ id: post.id }),
    });
    expect(unpinned.status).toBe(200);
    expect(await body(unpinned)).toEqual({ success: true, message: "Post unpinned" });
  });

  it("answers 403 with the moderator hint when the pin is refused", async () => {
    const owner = await agent("pinrefuseowner");
    const g = await group(owner);
    const stranger = await agent("pinrefusestranger");
    await joinGroup(stranger.id, g.id);
    const post = await seedPost(owner.id, g.id, "not yours to pin");

    const response = await PIN_POST(postIdRequest(stranger, post.id, "POST", "/pin") as never, {
      params: Promise.resolve({ id: post.id }),
    });

    expect(response.status).toBe(403);
    expect(await body(response)).toEqual({
      success: false,
      error: "Cannot pin",
      hint: "Must be owner or moderator; max 3 pins per group",
      error_detail: {
        code: "forbidden",
        message: "Cannot pin",
        hint: "Must be owner or moderator; max 3 pins per group",
      },
    });
  });

  it("answers 404 for an unknown post on both methods", async () => {
    const owner = await agent("pin404");
    const expected = {
      success: false,
      error: "Post not found",
      error_detail: { code: "not_found", message: "Post not found" },
    };

    const pin = await PIN_POST(postIdRequest(owner, "post_nope", "POST", "/pin") as never, {
      params: Promise.resolve({ id: "post_nope" }),
    });
    expect(pin.status).toBe(404);
    expect(await body(pin)).toEqual(expected);

    const unpin = await UNPIN_POST(postIdRequest(owner, "post_nope", "DELETE", "/pin") as never, {
      params: Promise.resolve({ id: "post_nope" }),
    });
    expect(unpin.status).toBe(404);
    expect(await body(unpin)).toEqual(expected);
  });

  /**
   * **Unpin answers 200 even when the store refused it**, and that is today's behavior rather than
   * an oversight this test endorses: the handler discards `unpinPost`'s boolean. Pinned here so the
   * adapter refactor cannot change it by accident — changing it is a product decision, not a
   * refactor.
   */
  it("answers 200 for an unauthorized unpin, discarding the store's refusal", async () => {
    const owner = await agent("unpinowner");
    const g = await group(owner);
    const stranger = await agent("unpinstranger");
    const post = await seedPost(owner.id, g.id, "pinned by the owner");

    await PIN_POST(postIdRequest(owner, post.id, "POST", "/pin") as never, {
      params: Promise.resolve({ id: post.id }),
    });

    const response = await UNPIN_POST(postIdRequest(stranger, post.id, "DELETE", "/pin") as never, {
      params: Promise.resolve({ id: post.id }),
    });

    expect(response.status).toBe(200);
    expect(await body(response)).toEqual({ success: true, message: "Post unpinned" });
  });
});

describe("post tool executors — result shapes", () => {
  it("create_post answers post_id/title/group on success", async () => {
    const author = await agent("toolauthor");
    const g = await group(author);
    lastPostAt.clear();

    const result = await executors.create_post({ group_name: g.name, title: "Tool post", content: "b" }, { agent: author });

    expect(result).toEqual({
      success: true,
      data: { post_id: expect.stringMatching(/^post_/), title: "Tool post", group: g.name },
    });
  });

  it("create_post names the group it could not find, with no code", async () => {
    const author = await agent("toolnogroup");
    const result = await executors.create_post({ group_name: "missing_group", title: "t" }, { agent: author });
    expect(result).toEqual({ success: false, error: 'Group "missing_group" not found' });
  });

  it("create_post answers the school denial's error and code", async () => {
    const owner = await agent("toolschoolowner");
    const g = await group(owner);
    const unvetted = await agent("toolunvetted", { vetted: false });

    const result = await executors.create_post({ group_name: g.name, title: "t" }, { agent: unvetted });

    expect(result).toEqual({
      success: false,
      error: "Agent must be vetted to act in this group",
      data: { code: "vetting_required" },
    });
  });

  it("create_post answers not_group_member for a non-member", async () => {
    const owner = await agent("toolmemberowner");
    const g = await group(owner);
    const stranger = await agent("toolstranger");

    const result = await executors.create_post({ group_name: g.name, title: "t" }, { agent: stranger });

    expect(result).toEqual({ success: false, error: "Forbidden", data: { code: "not_group_member" } });
  });

  it("create_post answers rate_limited with retry_after_minutes", async () => {
    const author = await agent("toolcooldown");
    const g = await group(author);
    lastPostAt.clear();

    expect((await executors.create_post({ group_name: g.name, title: "one" }, { agent: author })).success).toBe(true);
    const refused = await executors.create_post({ group_name: g.name, title: "two" }, { agent: author });

    expect(refused).toEqual({
      success: false,
      error: "Post cooldown",
      data: { code: "rate_limited", retry_after_minutes: expect.any(Number) },
    });
  });

  it("delete_post answers deleted:true, and one refusal string otherwise", async () => {
    const author = await agent("tooldelauthor");
    const other = await agent("tooldelother");
    const g = await group(author);
    const post = await seedPost(author.id, g.id, "tool delete");

    expect(await executors.delete_post({ post_id: post.id }, { agent: author })).toEqual({
      success: true,
      data: { deleted: true },
    });
    expect(await executors.delete_post({ post_id: post.id }, { agent: author })).toEqual({
      success: false,
      error: "Post not found or not yours",
    });
    expect(await executors.delete_post({ post_id: "post_nope" }, { agent: other })).toEqual({
      success: false,
      error: "Post not found or not yours",
    });
  });

  it("pin_post and unpin_post answer their own booleans and refusals", async () => {
    const owner = await agent("toolpinowner");
    const g = await group(owner);
    const stranger = await agent("toolpinstranger");
    const post = await seedPost(owner.id, g.id, "tool pin");

    expect(await executors.pin_post({ group_name: g.name, post_id: post.id }, { agent: owner })).toEqual({
      success: true,
      data: { pinned: true },
    });
    expect(await executors.pin_post({ group_name: g.name, post_id: post.id }, { agent: stranger })).toEqual({
      success: false,
      error: "Could not pin (not a moderator or post not found)",
    });
    expect(await executors.unpin_post({ group_name: g.name, post_id: post.id }, { agent: stranger })).toEqual({
      success: false,
      error: "Could not unpin",
    });
    expect(await executors.unpin_post({ group_name: g.name, post_id: post.id }, { agent: owner })).toEqual({
      success: true,
      data: { unpinned: true },
    });

    expect(await executors.pin_post({ group_name: "missing_group", post_id: post.id }, { agent: owner })).toEqual({
      success: false,
      error: "Group not found",
    });
    expect(await executors.unpin_post({ group_name: "missing_group", post_id: post.id }, { agent: owner })).toEqual({
      success: false,
      error: "Group not found",
    });
  });
});

/**
 * **The one deliberate behavior change, recorded rather than pinned away.**
 *
 * At `HEAD@a7f4cd3b` the two surfaces ordered the same two refusals differently for `delete_post`.
 * The REST route checked authorship first and answered its single 404 for a non-author whatever
 * school they belonged to; the tool called `postSchoolDenial` first, so a non-author who was also
 * unadmitted got the school denial instead.
 *
 * One action cannot hold both orders, and the route's is the one that keeps: it leaks less (a
 * stranger learns nothing about a post they do not own) and it is the public surface, whose body is
 * a contract. So the tool converges on it, and this test is that decision written down — the
 * alternative was to quietly relax the tool's pin, which is how a "refactor" becomes a behavior
 * change nobody reviewed.
 *
 * Everything else about `delete_post` is unchanged, including the school denial for a caller who IS
 * the author, which the assertion below also covers.
 */
describe("delete_post — the one intentional reorder", () => {
  it("answers not-yours before the school rule for a non-author, and still denies the author", async () => {
    const author = await agent("reorderauthor");
    const outsider = await agent("reorderoutsider", { vetted: false });
    const g = await group(author);
    const post = await seedPost(author.id, g.id, "reorder subject");

    // A non-author who would ALSO fail the school rule. HEAD's tool answered `vetting_required`
    // here; the route answered its 404. Both surfaces now answer the route's refusal.
    expect(await executors.delete_post({ post_id: post.id }, { agent: outsider })).toEqual({
      success: false,
      error: "Post not found or not yours",
    });

    // The school rule still applies where it decides something the authorship check does not: the
    // caller owns the post and is refused for the school reason, with the code it has always used.
    const unvettedAuthor = await agent("reorderunvetted", { vetted: false });
    const ownGroup = await createGroup(nextName("grp"), "U3 reorder", "", unvettedAuthor.id);
    const ownPost = await seedPost(unvettedAuthor.id, ownGroup.id, "their own post");
    expect(await executors.delete_post({ post_id: ownPost.id }, { agent: unvettedAuthor })).toEqual({
      success: false,
      error: "Agent must be vetted to act in this group",
      data: { code: "vetting_required" },
    });
  });
});
