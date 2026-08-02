/**
 * @jest-environment node
 *
 * M11-1b D3, memory mode + both caller surfaces: a comment's parent must be a comment on the
 * SAME post, validated ahead of the rate limit, refused as a validation error. The db-side races
 * run in `src/__tests__/integration/d3-comment-parent.test.ts`.
 */
import { executors } from "@/lib/agent-tools/definitions/comments";
import { createAgent, createComment, checkCommentRateLimit, listComments } from "@/lib/store";
import { seedPost } from "@/__tests__/helpers/store-fixtures";
import { agents } from "@/lib/store/_memory-state";

let seq = 0;

async function freshAgent() {
  const agent = await createAgent(`D3Mem_${Date.now()}_${seq++}`, "d3 fixture");
  agents.set(agent.id, { ...agents.get(agent.id)!, isVetted: true });
  return agent;
}

describe("createComment parent validation (memory)", () => {
  it("rejects a cross-post parent, costs no quota, and writes nothing", async () => {
    const author = await freshAgent();
    const postA = await seedPost(author.id, "d3_group", "A");
    const postB = await seedPost(author.id, "d3_group", "B");
    const parentOnB = await createComment(postB.id, author.id, "on B");
    expect(parentOnB).not.toBeNull();

    // A fresh agent so the quota assertion is unpolluted by the seed comment above.
    const replier = await freshAgent();
    const refused = await createComment(postA.id, replier.id, "cross-thread", parentOnB!.id);
    expect(refused).toBeNull();
    expect((await listComments(postA.id)).length).toBe(0);
    // The refused attempt consumed no allowance — the validation error, not the 429, must be
    // what a retry sees.
    expect((await checkCommentRateLimit(replier.id)).allowed).toBe(true);
  });

  it("rejects a nonexistent parent and accepts a same-post reply unchanged", async () => {
    const author = await freshAgent();
    const post = await seedPost(author.id, "d3_group", "thread");
    expect(await createComment(post.id, author.id, "reply", "comment_missing")).toBeNull();

    const top = await createComment(post.id, author.id, "top");
    expect(top).not.toBeNull();
    // Cooldown: back-date the last comment so the same-post reply is admitted.
    const { lastCommentAt } = jest.requireActual("@/lib/store/_memory-state") as {
      lastCommentAt: Map<string, number>;
    };
    lastCommentAt.set(author.id, Date.now() - 60_000);
    const reply = await createComment(post.id, author.id, "nested", top!.id);
    expect(reply?.parentId).toBe(top!.id);
  });
});

describe("validation precedes the rate limit (tool surface)", () => {
  it("a rate-limited caller with an invalid parent gets invalid_parent, never the 429 shape", async () => {
    const author = await freshAgent();
    const post = await seedPost(author.id, "d3_group", "precedence");
    // Exhaust the cooldown: one successful comment puts the agent inside the 20s window.
    expect(await createComment(post.id, author.id, "burn")).not.toBeNull();
    expect((await checkCommentRateLimit(author.id)).allowed).toBe(false);

    const result = await executors.create_comment(
      { post_id: post.id, content: "x", parent_id: "comment_missing" },
      { agent: agents.get(author.id)! } as never
    );
    expect(result.success).toBe(false);
    expect((result.data as { code: string }).code).toBe("invalid_parent");
  });

  it("a cross-post parent via the tool is refused with the same stable code", async () => {
    const author = await freshAgent();
    const postA = await seedPost(author.id, "d3_group", "A2");
    const postB = await seedPost(author.id, "d3_group", "B2");
    const parentOnB = await createComment(postB.id, author.id, "on B");

    const result = await executors.create_comment(
      { post_id: postA.id, content: "x", parent_id: parentOnB!.id },
      { agent: agents.get(author.id)! } as never
    );
    expect(result.success).toBe(false);
    expect((result.data as { code: string }).code).toBe("invalid_parent");
    expect((await listComments(postA.id)).length).toBe(0);
  });
});
