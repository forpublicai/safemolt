/**
 * M11-2 u3 — the two post surfaces are **adapters**, and this is what makes that checkable.
 *
 * The characterization file proves the wire shapes did not move; it cannot prove *where* they came
 * from, and a route that quietly kept its own copy of the membership check would pass it forever.
 * So this stubs the action module and asserts each surface delegates: the action is called with what
 * the caller supplied, and the surface renders whatever the action answered — including a refusal
 * the surface has no other way to produce.
 *
 * The second half is the P1.6 readiness check the plan asks for at this chunk: **no adapter may
 * import a mutating store export.** It is a source scan rather than a behavioural one because that
 * is the only form that catches a re-introduction; the lint rule and the AST test that make it
 * general arrive with P1.6.
 *
 * @jest-environment node
 */
jest.mock("@/lib/actions/posts", () => ({
  createPost: jest.fn(),
  deletePost: jest.fn(),
  pinPost: jest.fn(),
  unpinPost: jest.fn(),
}));

import { readFileSync } from "fs";
import { join } from "path";

import { POST as CREATE_POST } from "@/app/api/v1/posts/route";
import { DELETE as DELETE_POST } from "@/app/api/v1/posts/[id]/route";
import { POST as PIN_POST, DELETE as UNPIN_POST } from "@/app/api/v1/posts/[id]/pin/route";
import * as actions from "@/lib/actions/posts";
import { executors } from "@/lib/agent-tools/definitions/posts";
import { createAgent, getAgentById, setAgentVetted } from "@/lib/store/agents/memory";
import type { StoredAgent, StoredPost } from "@/lib/store-types";
import { withMiddlewareHeaders } from "../../helpers/middleware-headers";

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");

const createPost = actions.createPost as jest.Mock;
const deletePost = actions.deletePost as jest.Mock;
const pinPost = actions.pinPost as jest.Mock;
const unpinPost = actions.unpinPost as jest.Mock;

let seq = 0;

async function agent(): Promise<StoredAgent> {
  const created = await createAgent(`u3ad_${Date.now().toString(36)}_${(seq += 1)}`, "u3 adapter fixture");
  await setAgentVetted(created.id, "# adapter\n");
  return (await getAgentById(created.id))!;
}

const post = (id: string): StoredPost => ({
  id,
  title: "T",
  authorId: "a",
  groupId: "g",
  upvotes: 0,
  downvotes: 0,
  commentCount: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
});

function request(url: string, method: string, caller: StoredAgent, body?: unknown): Request {
  return new Request(
    url,
    withMiddlewareHeaders({
      method,
      headers: { Authorization: `Bearer ${caller.apiKey}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  );
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("REST routes delegate to the actions", () => {
  it("POST /posts passes the trimmed body and renders the action's result", async () => {
    const caller = await agent();
    createPost.mockResolvedValue({ ok: true, data: { post: post("post_x"), groupName: "canonical" } });

    const response = await CREATE_POST(
      request("https://safemolt.com/api/v1/posts", "POST", caller, {
        group: " general ",
        title: " T ",
        content: " c ",
      }) as never
    );

    expect(createPost).toHaveBeenCalledWith({
      agent: expect.objectContaining({ id: caller.id }),
      groupName: "general",
      title: "T",
      content: "c",
      url: undefined,
    });
    // The canonical group name comes from the ACTION, not from a second lookup in the route.
    expect((await response.json()).data.group).toBe("canonical");
  });

  it("POST /posts renders a refusal only the action could have decided", async () => {
    const caller = await agent();
    createPost.mockResolvedValue({ ok: false, code: "not_group_member", message: "Forbidden" });

    const response = await CREATE_POST(
      request("https://safemolt.com/api/v1/posts", "POST", caller, { group: "g", title: "t" }) as never
    );

    expect(response.status).toBe(403);
    expect((await response.json()).hint).toBe("You must be a member of this group to post in it. Join first.");
  });

  it("DELETE /posts/{id} passes the post id and renders the action's result", async () => {
    const caller = await agent();
    deletePost.mockResolvedValue({ ok: true, data: { post: post("post_y") } });

    const response = await DELETE_POST(
      request("https://safemolt.com/api/v1/posts/post_y", "DELETE", caller) as never,
      { params: Promise.resolve({ id: "post_y" }) }
    );

    expect(deletePost).toHaveBeenCalledWith({
      agent: expect.objectContaining({ id: caller.id }),
      postId: "post_y",
    });
    expect(await response.json()).toMatchObject({ success: true, message: "Post deleted" });
  });

  it("pin and unpin pass the post id with NO group name — the route resolves by post", async () => {
    const caller = await agent();
    pinPost.mockResolvedValue({ ok: true, data: { groupId: "g" } });
    unpinPost.mockResolvedValue({ ok: true, data: { groupId: "g" } });

    await PIN_POST(request("https://safemolt.com/api/v1/posts/post_z/pin", "POST", caller) as never, {
      params: Promise.resolve({ id: "post_z" }),
    });
    await UNPIN_POST(request("https://safemolt.com/api/v1/posts/post_z/pin", "DELETE", caller) as never, {
      params: Promise.resolve({ id: "post_z" }),
    });

    expect(pinPost).toHaveBeenCalledWith({ agent: expect.objectContaining({ id: caller.id }), postId: "post_z" });
    expect(unpinPost).toHaveBeenCalledWith({ agent: expect.objectContaining({ id: caller.id }), postId: "post_z" });
  });
});

describe("tool executors delegate to the same actions", () => {
  it("create_post passes the caller's group name and reports it back unchanged", async () => {
    const caller = await agent();
    createPost.mockResolvedValue({ ok: true, data: { post: post("post_t"), groupName: "canonical" } });

    const result = await executors.create_post({ group_name: "General", title: "T", content: "c" }, { agent: caller });

    expect(createPost).toHaveBeenCalledWith({ agent: caller, groupName: "General", title: "T", content: "c" });
    // The tool answers the name the CALLER used, which is its existing contract; the route answers
    // the canonical one. Both come from the same action.
    expect(result).toEqual({ success: true, data: { post_id: "post_t", title: "T", group: "General" } });
  });

  it("delete_post, pin_post and unpin_post delegate, pin/unpin naming their group", async () => {
    const caller = await agent();
    deletePost.mockResolvedValue({ ok: true, data: { post: post("post_d") } });
    pinPost.mockResolvedValue({ ok: true, data: { groupId: "g" } });
    unpinPost.mockResolvedValue({ ok: true, data: { groupId: "g" } });

    expect(await executors.delete_post({ post_id: "post_d" }, { agent: caller })).toEqual({
      success: true,
      data: { deleted: true },
    });
    await executors.pin_post({ group_name: "general", post_id: "post_p" }, { agent: caller });
    await executors.unpin_post({ group_name: "general", post_id: "post_p" }, { agent: caller });

    expect(deletePost).toHaveBeenCalledWith({ agent: caller, postId: "post_d" });
    expect(pinPost).toHaveBeenCalledWith({ agent: caller, postId: "post_p", groupName: "general" });
    expect(unpinPost).toHaveBeenCalledWith({ agent: caller, postId: "post_p", groupName: "general" });
  });
});

/**
 * P1.6 readiness, applied to the four files this chunk migrated.
 *
 * The boundary's general enforcement (a generated ESLint rule plus an AST-level discipline test over
 * `src/app/api/v1/**` and `src/lib/agent-tools/**`) is P1.6's, and it needs the store export manifest
 * that does not exist yet. What can be asserted today is the property those files must already have:
 * the post mutations are reached through the action and through nothing else.
 */
describe("adapters import no mutating post store export", () => {
  const ADAPTERS = [
    "src/app/api/v1/posts/route.ts",
    "src/app/api/v1/posts/[id]/route.ts",
    "src/app/api/v1/posts/[id]/pin/route.ts",
    "src/lib/agent-tools/definitions/posts.ts",
  ];
  /** The four mutations this chunk moved behind the action layer. */
  const MUTATIONS = ["createPost", "deletePost", "pinPost", "unpinPost"];

  it.each(ADAPTERS)("%s takes them from @/lib/actions/posts", (file) => {
    const source = readFileSync(join(REPO_ROOT, file), "utf8");
    // Every `import { … } from "<module>"` in the file, as (names, module) pairs.
    const imports = [...source.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+"([^"]+)"/g)].map(
      ([, names, module]) => ({
        names: names.split(",").map((name) => name.trim().split(/\s+as\s+/)[0].trim()),
        module,
      })
    );
    const offenders = imports
      .filter((entry) => entry.module === "@/lib/store" || entry.module === "@/lib/post-deletion")
      .flatMap((entry) => entry.names.filter((name) => MUTATIONS.includes(name)));
    expect(offenders).toEqual([]);
    // …and the file does reach the action layer, so the assertion above is not vacuous.
    expect(imports.some((entry) => entry.module === "@/lib/actions/posts")).toBe(true);
  });
});
