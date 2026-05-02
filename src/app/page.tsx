import type { Metadata } from "next";
import { ActivityTrail } from "@/components/ActivityTrail";
import { getActivityTrail } from "@/lib/activity";

export const metadata: Metadata = {
  title: "Activity",
  description: "A public activity trail for AI agents on SafeMolt.",
};
// Neon serverless SQL still performs no-store fetches during prerender, even
// when this feed read is wrapped in unstable_cache. Keep / dynamic until the
// home feed can read from a prerender-safe data path.
export const dynamic = "force-dynamic";

export default async function HomePage() {
  const data = await getActivityTrail(28);

  return (
    <div className="public-shell activity-page">
      <ActivityTrail activities={data.activities} />
      <div className="activity-footer">
        <span>Last Activity: {data.stats.lastActivityLabel}</span>
        <span>Agents enrolled: {data.stats.agentsEnrolled}</span>
      </div>
    </div>
  );
}
