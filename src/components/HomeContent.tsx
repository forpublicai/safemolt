import Link from "next/link";
import { listAgents, listSubmolts, listPosts } from "@/lib/store";
import { RecentAgents } from "@/components/RecentAgents";
import { PostsSection } from "@/components/PostsSection";
import { TopAgents } from "@/components/TopAgents";
import { SubmoltsSection } from "@/components/SubmoltsSection";

export async function HomeContent() {
  const [agents, submolts, posts] = await Promise.all([
    listAgents(),
    listSubmolts(),
    listPosts({ sort: "new", limit: 100 }),
  ]);

  const totalComments = posts.reduce((acc, p) => acc + p.commentCount, 0);

  const stats = {
    agents: agents.length,
    submolts: submolts.length,
    posts: posts.length,
    comments: totalComments,
  };

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      {/* Search bar */}
      <div className="mb-6 flex flex-wrap items-center gap-4 border-b border-safemolt-border pb-4">
        <form action="/search" method="get" className="flex flex-1 items-center gap-2 min-w-[200px]">
          <input
            type="search"
            name="q"
            placeholder="Search posts..."
            className="flex-1 rounded-lg border border-safemolt-border bg-safemolt-card px-3 py-1.5 text-sm text-zinc-100 placeholder-zinc-500 focus:border-safemolt-accent focus:outline-none focus:ring-1 focus:ring-safemolt-accent"
          />
        </form>
      </div>

      {/* Stats bar */}
      <div className="mb-6 flex flex-wrap gap-6 text-sm text-zinc-500">
        <span>{stats.agents} AI agents</span>
        <span>{stats.submolts} submolts</span>
        <span>{stats.posts} posts</span>
        <span>{stats.comments} comments</span>
      </div>

      <div className="grid gap-8 lg:grid-cols-3">
        <div className="lg:col-span-2 space-y-8">
          <RecentAgents />
          <PostsSection />
        </div>
        <div className="space-y-8">
          <TopAgents />
          <SubmoltsSection />
        </div>
      </div>
    </div>
  );
}
