/**
 * M11-2 u3f-lite (P1.4) — the Tier-1 COUPLING, and the Tier-B silence.
 *
 * The characterization suite proves the wire shapes did not move. This one proves the things that
 * are new, and every assertion is a property of a statement rather than of a code path:
 *
 *  - **no write without its event, no event without its write.** A profile edit that moves nothing,
 *    an identical avatar re-upload, a clear of an absent avatar and a delete of a path that is not
 *    there each write nothing and emit nothing;
 *  - **`payload.fields` is the STATEMENT's before/after diff.** A request offering three fields and
 *    moving one records the one;
 *  - **the reserved-key rule is the ACTION's and it is unconditional** — it refuses the delta the
 *    action is about to write, before anything is written;
 *  - **the memory twin preflights the whole batch before the mutation**, so an event this build
 *    cannot describe leaves the row untouched;
 *  - **memory mode refuses what Postgres refuses**: a context write for a withdrawn agent raises the
 *    same 23503 the `agent_context_files` foreign key raises there;
 *  - and the **Tier-B** paths — inbox read-state, raw vectors, the challenge fetch stamp — emit
 *    nothing at all, which is the whole of their tier.
 *
 * Jest runs with no database, so `@/lib/store` *is* the memory store and `eventLog` *is* the log.
 *
 * @jest-environment node
 */
jest.mock("@/auth", () => ({ auth: jest.fn(async () => null) }));

import { GET as CONTEXT_GET } from "@/app/api/v1/memory/context/file/route";
import { markVettingChallengeFetched } from "@/lib/actions/agents";
import { markAllInboxNotificationsRead, markInboxNotificationRead } from "@/lib/actions/inbox";
import {
  deleteMemoryVectors,
  removeContextFile,
  upsertMemoryVector,
  writeContextFile,
} from "@/lib/actions/memory";
import { clearMyAvatar, setMyAvatar, updateMyProfile } from "@/lib/actions/profile";
import * as contextStore from "@/lib/memory/context-store";
import {
  agents,
  apiKeyToAgentId,
  eventLog,
  notifications,
  vettingChallenges,
} from "@/lib/store/_memory-state";
import type { StoredAgent, StoredEvent, StoredNotification } from "@/lib/store-types";

import { withMiddlewareHeaders } from "../../helpers/middleware-headers";

let seq = 0;
const nextId = (label: string) => `u3fev${label}${Date.now().toString(36)}${(seq += 1)}`;

function seedAgent(overrides: Partial<StoredAgent> = {}): StoredAgent {
  const id = overrides.id ?? nextId("ag");
  const agent: StoredAgent = {
    id,
    name: overrides.name ?? id,
    description: "before",
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

/** Every event appended since the mark. The log is global and append-only within a run. */
function since(mark: number): StoredEvent[] {
  return eventLog.rows.filter((row) => row.id > mark);
}

function mark(): number {
  return eventLog.rows.length === 0 ? 0 : eventLog.rows[eventLog.rows.length - 1]!.id;
}

describe("profile — the event carries the statement's diff", () => {
  it("emits ONE agent.profile_updated naming only the fields that moved", async () => {
    const agent = seedAgent({ description: "before", displayName: "Shown", metadata: { keep: 1 } });
    const before = mark();

    // Three fields offered. Two of them are already at the value being written.
    const result = await updateMyProfile({
      agent,
      description: "after",
      displayName: "Shown",
      metadata: { keep: 1 },
    });

    expect(result.ok).toBe(true);
    expect(result.ok && result.data.changedFields).toEqual(["description"]);
    const emitted = since(before);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      kind: "agent.profile_updated",
      actorAgentId: agent.id,
      subjectType: "agent",
      subjectId: agent.id,
      schoolId: null,
      payload: { fields: ["description"] },
    });
  });

  it("names every field that moved, sorted", async () => {
    const agent = seedAgent({ description: "before" });
    const before = mark();
    await updateMyProfile({ agent, description: "after", displayName: "New", metadata: { bio: "hi" } });
    expect(since(before)[0]!.payload).toEqual({
      fields: ["description", "display_name", "metadata"],
    });
  });

  it("writes nothing and emits nothing when the edit moves nothing", async () => {
    const agent = seedAgent({ description: "same", displayName: "Same", metadata: { a: 1 } });
    const before = mark();

    const result = await updateMyProfile({
      agent,
      description: "same",
      displayName: "Same",
      metadata: { a: 1 },
    });

    expect(result.ok).toBe(true);
    expect(result.ok && result.data.changedFields).toEqual([]);
    expect(since(before)).toEqual([]);
  });

  it("treats a metadata delta that reorders a nested object as no change", async () => {
    // `jsonb` compares structurally and key-order-independently; the memory twin canonicalizes so
    // the two stores agree about whether anything moved.
    const agent = seedAgent({ metadata: { nested: { a: 1, b: 2 } } });
    const before = mark();
    const result = await updateMyProfile({ agent, metadata: { nested: { b: 2, a: 1 } } });
    expect(result.ok && result.data.changedFields).toEqual([]);
    expect(since(before)).toEqual([]);
  });

  it("refuses reserved keys before writing anything, through the action itself", async () => {
    const agent = seedAgent({ description: "untouched", metadata: { ao_fellow: true } });
    const before = mark();

    const result = await updateMyProfile({
      agent,
      description: "moved?",
      metadata: { ao_fellow: false, system: true, bio: "fine" },
    });

    expect(result).toMatchObject({
      ok: false,
      code: "bad_request",
      reason: "reserved_metadata_key",
      reservedKeys: ["ao_fellow", "system"],
    });
    // Total refusal: the description offered alongside the reserved keys is not applied either.
    expect(agents.get(agent.id)!.description).toBe("untouched");
    expect(agents.get(agent.id)!.metadata).toEqual({ ao_fellow: true });
    expect(since(before)).toEqual([]);
  });

  it("applies the rule to the delta it is about to WRITE, not to one request field", async () => {
    // The `emoji` shorthand is metadata under another name, and it is folded into the same delta
    // the rule inspects. It is not reserved, so it passes — the point is that it is CHECKED.
    const agent = seedAgent();
    const result = await updateMyProfile({ agent, emoji: "🦀" });
    expect(result.ok).toBe(true);
    expect(agents.get(agent.id)!.metadata).toEqual({ emoji: "🦀" });
  });

  it("refuses a non-object metadata with its own reason and writes nothing", async () => {
    const agent = seedAgent();
    const before = mark();
    const result = await updateMyProfile({ agent, metadata: ["nope"] });
    expect(result).toMatchObject({ ok: false, code: "bad_request", reason: "invalid_metadata" });
    expect(since(before)).toEqual([]);
  });

  it("answers not_found for an agent withdrawn between authentication and the write", async () => {
    const agent = seedAgent();
    agents.delete(agent.id);
    const before = mark();
    const result = await updateMyProfile({ agent, description: "after" });
    expect(result).toMatchObject({ ok: false, code: "not_found" });
    expect(since(before)).toEqual([]);
  });
});

describe("avatar — one kind, fields: ['avatar']", () => {
  it("emits on a real change and stays silent on an identical re-upload", async () => {
    const agent = seedAgent();
    const first = mark();
    await setMyAvatar({ agent, avatarUrl: "data:image/png;base64,AAA" });
    const emitted = since(first);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      kind: "agent.profile_updated",
      subjectId: agent.id,
      payload: { fields: ["avatar"] },
    });

    const second = mark();
    await setMyAvatar({ agent, avatarUrl: "data:image/png;base64,AAA" });
    expect(since(second)).toEqual([]);
  });

  it("emits on a clear that removed something and stays silent on one that did not", async () => {
    const agent = seedAgent({ avatarUrl: "data:image/png;base64,AAA" });
    const first = mark();
    await clearMyAvatar({ agent });
    expect(since(first)).toHaveLength(1);
    expect(agents.get(agent.id)!.avatarUrl).toBeUndefined();

    const second = mark();
    await clearMyAvatar({ agent });
    expect(since(second)).toEqual([]);
  });
});

describe("memory context files — Tier 1", () => {
  it("emits memory.context_written with lazy: false for an agent's own write", async () => {
    const agent = seedAgent();
    const before = mark();
    const result = await writeContextFile({ agentId: agent.id, path: "notes.md", content: "c" });
    expect(result.ok).toBe(true);
    const emitted = since(before);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      kind: "memory.context_written",
      actorAgentId: agent.id,
      subjectType: "agent",
      subjectId: agent.id,
      payload: { file_path: "notes.md", lazy: false },
    });
  });

  it("records lazy: true for the backfill, and names the NORMALIZED path", async () => {
    const agent = seedAgent();
    const before = mark();
    await writeContextFile({ agentId: agent.id, path: "/IDENTITY.md", content: "# me", lazy: true });
    expect(since(before)[0]!.payload).toEqual({ file_path: "IDENTITY.md", lazy: true });
  });

  it("drives the IDENTITY.md first-read backfill through the SAME action, with lazy: true", async () => {
    // The state-changing GET (inventory §4) is the one place `lazy` can be true in production, so
    // the flag is asserted through the ROUTE rather than only through a direct action call.
    const agent = seedAgent({ identityMd: "# who I am" });
    const before = mark();

    const response = await CONTEXT_GET(
      new Request("https://safemolt.com/api/v1/memory/context/file?path=IDENTITY.md", {
        ...withMiddlewareHeaders({ headers: { authorization: `Bearer ${agent.apiKey}` } }),
      })
    );

    expect(response.status).toBe(200);
    const emitted = since(before);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      kind: "memory.context_written",
      subjectId: agent.id,
      payload: { file_path: "IDENTITY.md", lazy: true },
    });
  });

  it("writes nothing and emits nothing for an invalid path", async () => {
    const agent = seedAgent();
    const before = mark();
    const result = await writeContextFile({ agentId: agent.id, path: "../escape.md", content: "c" });
    expect(result).toMatchObject({ ok: false, code: "bad_request", message: "invalid_path" });
    expect(since(before)).toEqual([]);
  });

  it("emits memory.context_deleted only when a row was removed", async () => {
    const agent = seedAgent();
    await writeContextFile({ agentId: agent.id, path: "gone.md", content: "c" });

    const first = mark();
    await removeContextFile({ agentId: agent.id, path: "gone.md" });
    const emitted = since(first);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      kind: "memory.context_deleted",
      subjectId: agent.id,
      payload: { file_path: "gone.md" },
    });

    // The same call again removes nothing — success, and silence.
    const second = mark();
    const again = await removeContextFile({ agentId: agent.id, path: "gone.md" });
    expect(again.ok).toBe(true);
    expect(since(second)).toEqual([]);
  });

  it("refuses a context write for a withdrawn agent, as the foreign key does", async () => {
    const agent = seedAgent();
    agents.delete(agent.id);
    const before = mark();

    await expect(writeContextFile({ agentId: agent.id, path: "orphan.md", content: "c" })).rejects.toMatchObject({
      code: "23503",
      constraint: "agent_context_files_agent_id_fkey",
    });
    expect(await contextStore.getContextFile(agent.id, "orphan.md")).toBeNull();
    expect(since(before)).toEqual([]);
  });

  it("leaves the row untouched when the batch cannot be described (event-failure injection)", async () => {
    const agent = seedAgent();
    const before = mark();
    // The preflight is what makes this safe: memory has no transaction, so the whole batch is
    // validated before the first write rather than as it is appended.
    await expect(
      contextStore.putContextFile(agent.id, "unwritten.md", "c", [
        { kind: "not.a.kind", payload: {} } as never,
      ])
    ).rejects.toThrow(/unknown kind/);
    expect(await contextStore.getContextFile(agent.id, "unwritten.md")).toBeNull();
    expect(since(before)).toEqual([]);
  });
});

describe("Tier B — the paths that deliberately emit nothing", () => {
  it("inbox read-state moves read_at and emits nothing", async () => {
    const agent = seedAgent();
    const row: StoredNotification = {
      id: nextId("nt"),
      agent_id: agent.id,
      type: "comment_on_my_post",
      priority: "normal",
      created_at: new Date().toISOString(),
      read_at: null,
      actor: { id: "x", name: "x", display_name: null, avatar_url: null },
      target: { type: "post", id: "p", title: "t" },
      href: "/post/p",
      metadata: {},
    } as StoredNotification;
    notifications.set(row.id, row);

    const before = mark();
    const one = await markInboxNotificationRead({ agent, notificationId: row.id });
    const all = await markAllInboxNotificationsRead({ agent });

    expect(one.ok && one.data.unreadCount).toBe(0);
    expect(all.ok && all.data.markedCount).toBe(0);
    expect(notifications.get(row.id)!.read_at).not.toBeNull();
    expect(since(before)).toEqual([]);
  });

  it("refuses a synthesized playground id and an unowned notification, writing nothing", async () => {
    const agent = seedAgent();
    const stranger = seedAgent();
    const theirs: StoredNotification = {
      id: nextId("nt"),
      agent_id: stranger.id,
      type: "comment_on_my_post",
      priority: "normal",
      created_at: new Date().toISOString(),
      read_at: null,
      actor: { id: "x", name: "x", display_name: null, avatar_url: null },
      target: { type: "post", id: "p", title: "t" },
      href: "/post/p",
      metadata: {},
    } as StoredNotification;
    notifications.set(theirs.id, theirs);

    const before = mark();
    expect(await markInboxNotificationRead({ agent, notificationId: "playground:1" })).toMatchObject({
      ok: false,
      reason: "read_state_unsupported",
    });
    expect(await markInboxNotificationRead({ agent, notificationId: theirs.id })).toMatchObject({
      ok: false,
      code: "not_found",
    });
    expect(notifications.get(theirs.id)!.read_at).toBeNull();
    expect(since(before)).toEqual([]);
  });

  it("raw vector upsert and delete emit nothing", async () => {
    const agent = seedAgent();
    const before = mark();
    expect(await upsertMemoryVector({ agentId: agent.id, id: "v1", text: "remember" })).toMatchObject({
      ok: true,
      data: { id: "v1" },
    });
    expect(await deleteMemoryVectors({ agentId: agent.id, ids: ["v1", "v2"] })).toMatchObject({
      ok: true,
      data: { deleted: 2 },
    });
    expect(since(before)).toEqual([]);
  });

  it("classifies an over-long vector text as bad_request rather than a backend failure", async () => {
    const agent = seedAgent();
    const result = await upsertMemoryVector({ agentId: agent.id, id: "v3", text: "x".repeat(200_001) });
    expect(result).toMatchObject({ ok: false, code: "bad_request" });
    expect(result.ok === false && result.message).toContain("exceeds max length");
  });

  it("the challenge fetch stamp emits nothing and reports whether a row moved", async () => {
    const agent = seedAgent();
    const id = nextId("vc");
    vettingChallenges.set(id, {
      id,
      agentId: agent.id,
      values: [1],
      nonce: "n",
      expectedHash: "h",
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      fetched: false,
      consumed: false,
    });

    const before = mark();
    expect(await markVettingChallengeFetched({ challengeId: id })).toEqual({ ok: true, data: { marked: true } });
    expect(await markVettingChallengeFetched({ challengeId: "nope" })).toEqual({
      ok: true,
      data: { marked: false },
    });
    expect(vettingChallenges.get(id)!.fetched).toBe(true);
    expect(since(before)).toEqual([]);
  });
});
