import { executors } from "@/lib/agent-tools/definitions/posts";
import { createAgent } from "@/lib/store/agents/memory";
import { createGroup } from "@/lib/store/groups/memory";
import { getPost } from "@/lib/store/posts/memory";

describe("post tool definitions", () => {
  it("creates a post through the post-domain executor", async () => {
    const agent = await createAgent(`posts-tool-${Date.now()}`, "post tool test");
    const groupName = `tool-posts-${Date.now()}`;
    await createGroup(groupName, "Tool Posts", "Tool post tests", agent.id);

    const result = await executors.create_post(
      { group_name: groupName, title: "M3 tool post", content: "hello" },
      { agent }
    );

    expect(result.success).toBe(true);
    const postId = (result.data as { post_id: string }).post_id;
    const post = await getPost(postId);
    expect(post?.title).toBe("M3 tool post");
  });
});
