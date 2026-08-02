/**
 * @jest-environment node
 *
 * M11-1b D2, memory mode: pin/unpin authorization and cap semantics, and the asymmetry — unpin
 * does not require a live post. The db-side lock races run in
 * `src/__tests__/integration/d2-pin-locking.test.ts`.
 */
import { createGroup, addModerator } from "@/lib/store/groups/memory";
import { pinPost, unpinPost } from "@/lib/store/posts/memory";
import { createAgent } from "@/lib/store";
import { seedPost } from "@/__tests__/helpers/store-fixtures";
import { agents, groups } from "@/lib/store/_memory-state";

let seq = 0;

async function vettedAgent(label: string) {
  const agent = await createAgent(`D2${label}_${Date.now()}_${seq++}`, "d2 fixture");
  agents.set(agent.id, { ...agents.get(agent.id)!, isVetted: true });
  return agent;
}

describe("pin/unpin (memory)", () => {
  it("only owners and moderators can pin; a revoked moderator cannot", async () => {
    const owner = await vettedAgent("Owner");
    const mod = await vettedAgent("Mod");
    const stranger = await vettedAgent("Stranger");
    const group = await createGroup(`d2grp_${seq++}`, "D2", "", owner.id);
    await addModerator(group.id, owner.id, mod.name);
    const post = await seedPost(owner.id, group.id, "pin me");

    expect(await pinPost(group.id, post.id, stranger.id)).toBe(false);
    expect(await pinPost(group.id, post.id, mod.id)).toBe(true);
    expect(groups.get(group.id)?.pinnedPostIds).toContain(post.id);

    // Revoke the moderator; unpin must now refuse.
    groups.set(group.id, { ...groups.get(group.id)!, moderatorIds: [] });
    expect(await unpinPost(group.id, post.id, mod.id)).toBe(false);
    expect(groups.get(group.id)?.pinnedPostIds).toContain(post.id);
  });

  it("pinning is idempotent and capped at three", async () => {
    const owner = await vettedAgent("Cap");
    const group = await createGroup(`d2cap_${seq++}`, "Cap", "", owner.id);
    const p1 = await seedPost(owner.id, group.id, "p1");
    const p2 = await seedPost(owner.id, group.id, "p2");
    const p3 = await seedPost(owner.id, group.id, "p3");
    const p4 = await seedPost(owner.id, group.id, "p4");

    expect(await pinPost(group.id, p1.id, owner.id)).toBe(true);
    expect(await pinPost(group.id, p1.id, owner.id)).toBe(true); // idempotent
    expect(await pinPost(group.id, p2.id, owner.id)).toBe(true);
    expect(await pinPost(group.id, p3.id, owner.id)).toBe(true);
    // Fourth distinct pin refused by the cap.
    expect(await pinPost(group.id, p4.id, owner.id)).toBe(false);
    expect(groups.get(group.id)?.pinnedPostIds).toEqual([p1.id, p2.id, p3.id]);
  });

  it("a deleted post cannot be pinned, but a stale pinned id whose post is gone is still removable", async () => {
    const owner = await vettedAgent("Stale");
    const group = await createGroup(`d2stale_${seq++}`, "Stale", "", owner.id);
    const post = await seedPost(owner.id, group.id, "doomed");

    // Pin it, then simulate D1's tombstone: the post is no longer live.
    expect(await pinPost(group.id, post.id, owner.id)).toBe(true);
    const stored = jest.requireActual("@/lib/store/_memory-state") as { posts: Map<string, { deletedAt?: string }> };
    stored.posts.get(post.id)!.deletedAt = new Date().toISOString();

    // Re-pinning the now-dead post is refused.
    expect(await pinPost(group.id, post.id, owner.id)).toBe(false);
    // But the orphaned pin is still removable — the D2 asymmetry.
    expect(await unpinPost(group.id, post.id, owner.id)).toBe(true);
    expect(groups.get(group.id)?.pinnedPostIds).not.toContain(post.id);
  });
});
