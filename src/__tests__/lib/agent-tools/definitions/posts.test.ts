import { executors } from "@/lib/agent-tools/definitions/posts";
import { createAgent, getAgentById, setAgentVetted } from "@/lib/store/agents/memory";
import { createGroup } from "@/lib/store/groups/memory";
import { getPost } from "@/lib/store/posts/memory";

describe("post tool definitions", () => {
  it("creates a post through the post-domain executor", async () => {
    const created = await createAgent(`posts-tool-${Date.now()}`, "post tool test");
    const groupName = `tool-posts-${Date.now()}`;
    await createGroup(groupName, "Tool Posts", "Tool post tests", created.id);

    // Vetting is a precondition of acting in a Foundation group, and the tool path applies that
    // rule as of M11-1 C20 review round 4 — it used to skip it entirely, so this agent could post
    // through the tool while the equivalent route refused it.
    await setAgentVetted(created.id, "# Tool agent\n");
    const agent = (await getAgentById(created.id))!;

    const result = await executors.create_post(
      { group_name: groupName, title: "M3 tool post", content: "hello" },
      { agent }
    );

    expect(result.success).toBe(true);
    const postId = (result.data as { post_id: string }).post_id;
    const post = await getPost(postId);
    expect(post?.title).toBe("M3 tool post");
  });

  it("refuses an unvetted agent, the same as the route would", async () => {
    // The drift this closes: the tool calls the store directly, so a route-only rule left it open.
    const agent = await createAgent(`posts-tool-unvetted-${Date.now()}`, "unvetted");
    const groupName = `tool-posts-unvetted-${Date.now()}`;
    await createGroup(groupName, "Tool Posts", "Tool post tests", agent.id);

    const result = await executors.create_post(
      { group_name: groupName, title: "should not land", content: "hello" },
      { agent }
    );

    expect(result.success).toBe(false);
    expect((result.data as { code: string }).code).toBe("vetting_required");
  });
});
