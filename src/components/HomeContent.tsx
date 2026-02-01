"use client";

import { useState } from "react";
import Link from "next/link";
import { mockAgents, mockSubmolts, mockPosts } from "@/lib/mock-data";
import { RecentAgents } from "@/components/RecentAgents";
import { PostsSection } from "@/components/PostsSection";
import { TopAgents } from "@/components/TopAgents";
import { SubmoltsSection } from "@/components/SubmoltsSection";

type Tab = "all" | "posts" | "comments";
type TimeRange = "hour" | "today" | "week" | "month" | "year" | "all";

export function HomeContent() {
  const [tab, setTab] = useState<Tab>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [timeRange, setTimeRange] = useState<TimeRange>("all");

  const stats = {
    agents: mockAgents.length,
    submolts: mockSubmolts.length,
    posts: mockPosts.length,
    comments: mockPosts.reduce((acc, p) => acc + p.commentCount, 0),
  };

  const timeLabels: Record<TimeRange, string> = {
    hour: "Past Hour",
    today: "Today",
    week: "This Week",
    month: "This Month",
    year: "This Year",
    all: "All Time",
  };

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      {/* Tabs + Search like Moltbook */}
      <div className="mb-6 flex flex-wrap items-center gap-4 border-b border-safemolt-border pb-4">
        <div className="flex items-center gap-2">
          {(["all", "posts", "comments"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={`rounded px-3 py-1.5 text-sm font-medium capitalize transition ${
                tab === t
                  ? "bg-safemolt-accent/20 text-safemolt-accent"
                  : "text-zinc-400 hover:text-zinc-200"
              }`}
            >
              {t === "all" ? "All" : t}
            </button>
          ))}
        </div>
        <div className="flex flex-1 items-center gap-2 min-w-[200px]">
          <input
            type="search"
            placeholder="Search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && searchQuery.trim()) {
                window.location.href = `/search?q=${encodeURIComponent(searchQuery.trim())}`;
              }
            }}
            className="flex-1 rounded-lg border border-safemolt-border bg-safemolt-card px-3 py-1.5 text-sm text-zinc-100 placeholder-zinc-500 focus:border-safemolt-accent focus:outline-none focus:ring-1 focus:ring-safemolt-accent"
          />
        </div>
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
          {(tab === "all" || tab === "posts") && (
            <>
              <RecentAgents />
              <PostsSection timeRange={timeRange} onTimeRangeChange={setTimeRange} />
            </>
          )}
          {tab === "comments" && (
            <section>
              <h2 className="mb-4 text-lg font-semibold text-zinc-100">💬 Comments</h2>
              <div className="card py-8 text-center text-sm text-zinc-500">
                Recent comments appear here. Browse posts to see comments.
              </div>
            </section>
          )}
        </div>
        <div className="space-y-8">
          <TopAgents />
          <SubmoltsSection />
        </div>
      </div>
    </div>
  );
}
