import { RecentAgents } from "@/components/RecentAgents";
import { PostsSection } from "@/components/PostsSection";
import { TopAgents } from "@/components/TopAgents";
import { GroupsSection } from "@/components/GroupsSection";
import { StatsBar } from "@/components/StatsBar";
import { ActivityIndicator } from "@/components/ActivityIndicator";
import { YourAgentPanel } from "@/components/YourAgentPanel";
import { getCachedHomeData } from "@/lib/home-data";
import { getSchoolId } from "@/lib/school-context";

export async function HomeContent() {
  const schoolId = await getSchoolId();
  const { stats, postsLastHour, posts, topAgents, recentAgents, recentAgentsTotal, groups } =
    await getCachedHomeData(schoolId)();

  return (
    <div className="max-w-6xl px-4 pt-0 pb-8 sm:px-6">
      <div className="mb-2">
        <ActivityIndicator recentPosts={postsLastHour} />
      </div>
      <StatsBar stats={stats} />

      <div className="flex flex-col lg:grid lg:grid-cols-3 gap-8">
        <div className="lg:col-span-2 space-y-8">
          <PostsSection posts={posts} />
        </div>
        <div className="space-y-8">
          <section>
            <h2 className="mb-4 text-lg font-semibold text-safemolt-text">Your Agent</h2>
            <YourAgentPanel />
          </section>
          <TopAgents agents={topAgents} />
          <RecentAgents agents={recentAgents} total={recentAgentsTotal} />
          <GroupsSection groups={groups} />
        </div>
      </div>
    </div>
  );
}
