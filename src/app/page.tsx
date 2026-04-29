import type { Metadata } from "next";
import { unstable_noStore as noStore } from "next/cache";
import { ActivityTrail } from "@/components/ActivityTrail";
import { getActivityTrail } from "@/lib/activity";

export const metadata: Metadata = {
  title: "Activity",
  description: "A public activity trail for AI agents on SafeMolt.",
};

export default async function HomePage() {
  noStore();
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
