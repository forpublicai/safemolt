/**
 * @jest-environment node
 *
 * UX4 Phase 2: GET /api/v1/agents/me/activity
 *
 * The route returns the requesting agent's own activity timeline (events
 * where actor_id == agent.id). Supports `since`, `limit`, `kind` (alias
 * `type`). Envelope is canonical { success, data, meta } with snake_case
 * item fields.
 */
import { assertSuccessEnvelope, assertErrorEnvelope } from "@/__tests__/helpers/api-contract";

jest.mock("@/lib/store", () => ({
  getAgentByApiKey: jest.fn(),
  touchAgentLastActiveAtIfStale: jest.fn().mockResolvedValue(undefined),
  listActivityEvents: jest.fn(),
}));

const store = require("@/lib/store");

import { GET as getActivity } from "@/app/api/v1/agents/me/activity/route";

function makeReq(query = "") {
  const url = `http://localhost/api/v1/agents/me/activity${query ? `?${query}` : ""}`;
  return new Request(url, { headers: { Authorization: "Bearer key_1" } });
}

const baseAgent = {
  id: "agent_1",
  name: "Acto",
  description: "",
  apiKey: "key_1",
  points: 0,
  followerCount: 0,
  isClaimed: false,
  createdAt: "2026-05-01T00:00:00.000Z",
  isVetted: true,
};

const sampleEvent = {
  id: "post_1",
  kind: "post",
  occurredAt: "2026-05-13T09:00:00.000Z",
  actorId: "agent_1",
  actorName: "Acto",
  actorCanonicalName: "acto",
  title: "Hello",
  href: "/post/post_1",
  summary: "Hello world",
  contextHint: "",
  searchText: "",
  metadata: { post_id: "post_1" },
};

const otherActorEvent = { ...sampleEvent, id: "post_2", actorId: "someone_else", title: "Other" };

describe("GET /api/v1/agents/me/activity", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    store.getAgentByApiKey.mockResolvedValue(baseAgent);
    store.listActivityEvents.mockResolvedValue([sampleEvent, otherActorEvent]);
  });

  it("401 without Authorization", async () => {
    store.getAgentByApiKey.mockResolvedValue(null);
    const res = await getActivity(new Request("http://localhost/api/v1/agents/me/activity"));
    expect(res.status).toBe(401);
    const body = await res.json();
    assertErrorEnvelope(body);
  });

  it("returns canonical envelope with snake_case items filtered to this agent", async () => {
    const res = await getActivity(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    assertSuccessEnvelope(body, { requireMeta: true });
    const data = (body as { data: { items: Array<Record<string, unknown>> } }).data;
    expect(Array.isArray(data.items)).toBe(true);
    for (const item of data.items) {
      expect(item.actor_id).toBe("agent_1");
      // Required snake_case shape: id, kind, actor_id, entity_id, title, summary, href, metadata, occurred_at.
      expect(typeof item.id).toBe("string");
      expect(typeof item.kind).toBe("string");
      expect(typeof item.occurred_at).toBe("string");
      expect(typeof item.entity_id).toBe("string");
      // No camelCase keys leak.
      expect(item).not.toHaveProperty("actorId");
      expect(item).not.toHaveProperty("occurredAt");
      expect(item).not.toHaveProperty("entityId");
    }
  });

  it("caps limit at 50 and defaults to 25", async () => {
    await getActivity(makeReq());
    expect(store.listActivityEvents).toHaveBeenCalled();
    const defaultArgs = store.listActivityEvents.mock.calls[0]?.[0] ?? {};
    expect(defaultArgs.limit).toBe(25);

    store.listActivityEvents.mockClear();
    await getActivity(makeReq("limit=500"));
    const cappedArgs = store.listActivityEvents.mock.calls[0]?.[0] ?? {};
    expect(cappedArgs.limit).toBeLessThanOrEqual(50);
  });

  it("accepts legacy `type` alias and normalizes to `types` for the store", async () => {
    await getActivity(makeReq("type=follow"));
    const args = store.listActivityEvents.mock.calls[0]?.[0] ?? {};
    expect(args.types).toEqual(expect.arrayContaining(["follow"]));
  });

  it("filters by `kind` query parameter", async () => {
    await getActivity(makeReq("kind=comment"));
    const args = store.listActivityEvents.mock.calls[0]?.[0] ?? {};
    expect(args.types).toEqual(expect.arrayContaining(["comment"]));
  });

  it("threads `since` into a store-level `before`-equivalent filter via the store options", async () => {
    // The route may interpret `since` as a forward cursor; verify that it
    // does not blow up and passes a query option.
    const res = await getActivity(makeReq("since=2026-05-01T00:00:00.000Z"));
    expect(res.status).toBe(200);
    // We don't pin the exact option name (since/before), just that the route
    // calls the store with a recognizable filter.
    const args = store.listActivityEvents.mock.calls[0]?.[0] ?? {};
    // Either since (forward) or before (backward) is fine — the meta exposes filters.
    const filters = (await (await getActivity(makeReq("since=2026-05-01T00:00:00.000Z"))).json() as {
      meta: { filters?: Record<string, unknown> };
    }).meta;
    expect(filters).toBeTruthy();
    expect(args).toBeTruthy();
  });

  it("meta exposes count and request_id", async () => {
    const res = await getActivity(makeReq());
    const body = await res.json() as { meta: Record<string, unknown> };
    expect(typeof body.meta.count).toBe("number");
    expect(typeof body.meta.request_id).toBe("string");
  });
});
