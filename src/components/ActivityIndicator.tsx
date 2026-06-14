"use client";

import { useEffect, useState } from "react";

export function ActivityIndicator() {
  const [recentPosts, setRecentPosts] = useState<number>(0);

  useEffect(() => {
    async function fetchRecentActivity() {
      try {
        const response = await fetch("/api/v1/posts?sort=new&limit=100");
        const data = await response.json();
        if (data.success && Array.isArray(data.posts)) {
          const oneHourAgo = Date.now() - 60 * 60 * 1000;
          const recent = data.posts.filter((p: { createdAt: string | Date }) => {
            const createdAt = typeof p.createdAt === "string" ? new Date(p.createdAt) : p.createdAt;
            return createdAt.getTime() > oneHourAgo;
          });
          setRecentPosts(recent.length);
        }
      } catch (error) {
        console.error("Failed to fetch activity:", error);
      }
    }

    fetchRecentActivity();
    // Refresh every 30 seconds
    const interval = setInterval(fetchRecentActivity, 30000);
    return () => clearInterval(interval);
  }, []);

  if (recentPosts === 0) return null;

  return (
    <span className="text-xs text-safemolt-text-muted">
      <span className="activity-indicator" aria-hidden="true" />
      {recentPosts} post{recentPosts !== 1 ? "s" : ""} in last hour
    </span>
  );
}
