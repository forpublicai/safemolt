/**
 * M11-1b D2 + M11-1 C25 — the REST unpin route must tolerate a tombstone.
 *
 * D2 made `unpinPost` work without a live post on purpose: clearing a stale id left behind by an
 * older delete is the whole reason a moderator reaches for unpin. C25 then made `getPost` hide
 * soft-deleted rows. A route that resolves the post through `getPost` before calling the store
 * therefore re-imposes the live-post requirement the store deliberately dropped, and the group's
 * three-pin cap loses a slot permanently.
 *
 * The store-level gate for this already passes (`src/__tests__/lib/store/posts/d2-pin-locking.test.ts`)
 * — which is exactly why it did not catch this: the defect lived one layer up. So this exercises
 * the real handler.
 *
 * No mocks: Jest runs with no database, so `@/lib/store` *is* the memory store.
 *
 * @jest-environment node
 */
import { DELETE, POST } from "@/app/api/v1/posts/[id]/pin/route";
import { createAgent, getAgentById, setAgentVetted } from "@/lib/store/agents/memory";
import { createGroup } from "@/lib/store/groups/memory";
import { groups, posts } from "@/lib/store/_memory-state";
import { seedPost } from "@/__tests__/helpers/store-fixtures";
import type { StoredAgent } from "@/lib/store-types";
import { withMiddlewareHeaders } from "../../helpers/middleware-headers";

let seq = 0;

async function vettedAgent(label: string): Promise<StoredAgent> {
  const created = await createAgent(`d2unpin_${label}_${Date.now()}_${seq++}`, "d2 unpin fixture");
  await setAgentVetted(created.id, `# ${label}\n`);
  return (await getAgentById(created.id))!;
}

function pinRequest(agent: StoredAgent, postId: string, method: "POST" | "DELETE"): Request {
  return new Request(`https://safemolt.com/api/v1/posts/${postId}/pin`, withMiddlewareHeaders({
    method,
    headers: { Authorization: `Bearer ${agent.apiKey}` },
  }));
}

describe("DELETE /api/v1/posts/{id}/pin against a soft-deleted post", () => {
  it("removes the stale pin instead of answering 404, so the pin slot is not lost", async () => {
    const owner = await vettedAgent("owner");
    const group = await createGroup(`d2unpingrp_${seq++}`, "D2 unpin", "", owner.id);
    const post = await seedPost(owner.id, group.id, "pin then delete me");

    const pinned = await POST(
      pinRequest(owner, post.id, "POST") as never,
      { params: Promise.resolve({ id: post.id }) }
    );
    expect(pinned.status).toBe(200);
    expect(groups.get(group.id)?.pinnedPostIds).toContain(post.id);

    // Soft-delete the post: `getPost` now hides it, `getPostIncludingDeleted` does not.
    posts.get(post.id)!.deletedAt = new Date().toISOString();

    const response = await DELETE(
      pinRequest(owner, post.id, "DELETE") as never,
      { params: Promise.resolve({ id: post.id }) }
    );

    expect(response.status).toBe(200);
    expect(groups.get(group.id)?.pinnedPostIds ?? []).not.toContain(post.id);
  });

  it("still refuses to PIN a soft-deleted post — only removal is tombstone-tolerant", async () => {
    const owner = await vettedAgent("pinowner");
    const group = await createGroup(`d2pingrp_${seq++}`, "D2 pin", "", owner.id);
    const post = await seedPost(owner.id, group.id, "already gone");
    posts.get(post.id)!.deletedAt = new Date().toISOString();

    const response = await POST(
      pinRequest(owner, post.id, "POST") as never,
      { params: Promise.resolve({ id: post.id }) }
    );

    expect(response.status).toBe(404);
    expect(groups.get(group.id)?.pinnedPostIds ?? []).not.toContain(post.id);
  });

  it("answers 404 when the post never existed at all", async () => {
    const owner = await vettedAgent("ghost");
    const response = await DELETE(
      pinRequest(owner, "post_does_not_exist", "DELETE") as never,
      { params: Promise.resolve({ id: "post_does_not_exist" }) }
    );
    expect(response.status).toBe(404);
  });
});
