/**
 * M11b lane M (codex round 1 F5) — the `source_id` override on a derived event applies ONLY when
 * that event's own payload carries `STORE_ASSIGNED_PAYLOAD_ID`. A derived event that already names
 * its own `source_id` must keep it, in both `createPost` and `createCommentWithOutcome`.
 *
 * @jest-environment node
 */
jest.mock("@/lib/db", () => ({ hasDatabase: () => false, sql: null }));

import { STORE_ASSIGNED_PAYLOAD_ID, type PreparedEvent } from "@/lib/events/kinds";
import { eventLog } from "@/lib/store/_memory-state";
import { createAgent } from "@/lib/store/agents/memory";
import { createGroup } from "@/lib/store/groups/memory";
import { createPost } from "@/lib/store/posts/memory";
import { createCommentWithOutcome } from "@/lib/store/comments/memory";

let seq = 0;
const nextName = (label: string) => `f5_${label}_${Date.now().toString(36)}_${(seq += 1)}`;

function mentionEvent(
  actorAgentId: string,
  mentionedAgentId: string,
  sourceId: string
): PreparedEvent<"agent.mentioned"> {
  return {
    kind: "agent.mentioned",
    actorAgentId,
    subjectType: "agent",
    subjectId: mentionedAgentId,
    schoolId: null,
    payload: { source_type: "post", source_id: sourceId, mentioned_agent_id: mentionedAgentId },
  };
}

function eventsSince(marker: number) {
  return eventLog.rows.filter((event) => event.id > marker);
}

describe("marker-gated source_id override", () => {
  it("createPost fills only the marker, and leaves a derived event's own source_id alone", async () => {
    const author = await createAgent(nextName("author"), "d");
    const withMarker = await createAgent(nextName("with-marker"), "d");
    const ownId = await createAgent(nextName("own-id"), "d");
    const group = await createGroup(nextName("group"), "Group", "d", author.id);
    const marker = eventLog.nextId - 1;

    const post = await createPost(author.id, group.id, "t", "c", undefined, [
      {
        kind: "post.created",
        actorAgentId: author.id,
        subjectType: "post",
        subjectId: STORE_ASSIGNED_PAYLOAD_ID,
        schoolId: null,
        payload: { post_id: STORE_ASSIGNED_PAYLOAD_ID, group_id: group.id, author_id: author.id },
      } satisfies PreparedEvent<"post.created">,
      mentionEvent(author.id, withMarker.id, STORE_ASSIGNED_PAYLOAD_ID),
      mentionEvent(author.id, ownId.id, "explicit-source-id"),
    ]);
    expect(post).not.toBeNull();

    const emitted = eventsSince(marker);
    const filled = emitted.find((e) => e.subjectId === withMarker.id);
    const kept = emitted.find((e) => e.subjectId === ownId.id);
    expect(filled?.payload.source_id).toBe(post!.id);
    expect(kept?.payload.source_id).toBe("explicit-source-id");
  });

  it("createCommentWithOutcome fills only the marker, and leaves a derived event's own source_id alone", async () => {
    const author = await createAgent(nextName("author"), "d");
    const commenter = await createAgent(nextName("commenter"), "d");
    const withMarker = await createAgent(nextName("with-marker"), "d");
    const ownId = await createAgent(nextName("own-id"), "d");
    const group = await createGroup(nextName("group"), "Group", "d", author.id);
    const post = await createPost(author.id, group.id, "t", "c");
    expect(post).not.toBeNull();
    const marker = eventLog.nextId - 1;

    const outcome = await createCommentWithOutcome(post!.id, commenter.id, "cc", undefined, [
      {
        kind: "comment.created",
        actorAgentId: commenter.id,
        subjectType: "comment",
        subjectId: STORE_ASSIGNED_PAYLOAD_ID,
        secondarySubjectId: post!.id,
        schoolId: null,
        payload: { comment_id: STORE_ASSIGNED_PAYLOAD_ID, post_id: post!.id, parent_id: null },
      } satisfies PreparedEvent<"comment.created">,
      mentionEvent(commenter.id, withMarker.id, STORE_ASSIGNED_PAYLOAD_ID),
      mentionEvent(commenter.id, ownId.id, "explicit-source-id"),
    ]);
    expect(outcome.comment).not.toBeNull();

    const emitted = eventsSince(marker);
    const filled = emitted.find((e) => e.subjectId === withMarker.id);
    const kept = emitted.find((e) => e.subjectId === ownId.id);
    expect(filled?.payload.source_id).toBe(outcome.comment!.id);
    expect(kept?.payload.source_id).toBe("explicit-source-id");
  });
});
