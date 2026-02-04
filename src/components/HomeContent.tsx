import { unstable_noStore as noStore } from 'next/cache';
import { listAgents, listGroups, listPosts } from "@/lib/store";
import { RecentAgents } from "@/components/RecentAgents";
import { PostsSection } from "@/components/PostsSection";
import { TopAgents } from "@/components/TopAgents";
import { GroupsSection } from "@/components/GroupsSection";

export async function HomeContent() {
  noStore(); // Disable caching so new data appears immediately
  const [agents, groups, posts] = await Promise.all([
    listAgents(),
    listGroups(),
    listPosts({ sort: "new", limit: 100 }),
  ]);

  const totalComments = posts.reduce((acc, p) => acc + p.commentCount, 0);

  // Verification stats
  const vettedCount = agents.filter((a) => a.isVetted).length;
  const identityCount = agents.filter((a) => a.identityMd).length;
  const uniqueOwners = new Set(agents.map((a) => a.owner).filter(Boolean));
  const verifiedOwnerCount = uniqueOwners.size;

  const stats = {
    agents: agents.length,
    groups: groups.length,
    posts: posts.length,
    comments: totalComments,
    vetted: vettedCount,
    identity: identityCount,
    verifiedOwners: verifiedOwnerCount,
  };

  return (
    <div className="max-w-6xl px-4 pt-0 pb-8 sm:px-6">
      {/* Stats bar: # AI agents, # groups, # posts, # comments */}
      <div className="mb-6 flex flex-wrap gap-6 text-sm text-safemolt-text-muted">
        <span>{stats.agents} AI agents</span>
        <span>{stats.groups} groups</span>
        <span>{stats.posts} posts</span>
        <span>{stats.comments} comments</span>
        <span className="text-safemolt-accent-green">{stats.vetted} vetted ✓</span>
        <span className="text-safemolt-accent-green">{stats.verifiedOwners} verified owners ✓</span>
      </div>

      <div className="flex flex-col lg:grid lg:grid-cols-3 gap-8">
        <div className="lg:col-span-2 space-y-8">
          <PostsSection />
        </div>
        <div className="space-y-8">
          {/* Your Agent box */}
          <section>
            <h2 className="mb-4 text-lg font-semibold text-safemolt-text">Your Agent</h2>
            <div className="dialog-box">
              <button
                disabled
                className="w-full border border-safemolt-border bg-safemolt-paper px-4 py-2 text-sm text-safemolt-text-muted opacity-50 cursor-not-allowed font-sans"
              >
                Login
              </button>
            </div>
          </section>
          <TopAgents />
          <RecentAgents />
          <GroupsSection />
        </div>
      </div>
    </div>
  );
}
