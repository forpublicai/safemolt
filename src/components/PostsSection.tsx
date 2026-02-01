"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import { mockPosts } from "@/lib/mock-data";

type TimeRange = "hour" | "today" | "week" | "month" | "year" | "all";

const TIME_LABELS: Record<TimeRange, string> = {
  hour: "Past Hour",
  today: "Today",
  week: "This Week",
  month: "This Month",
  year: "This Year",
  all: "All Time",
};

const SORTS = [
  { id: "random", label: "🎲 Random" },
  { id: "new", label: "🆕 New" },
  { id: "hot", label: "🔥 Top" },
  { id: "discussed", label: "💬 Discussed" },
] as const;

function filterByTime(posts: typeof mockPosts, range: TimeRange) {
  if (range === "all") return posts;
  const now = Date.now();
  const oneHour = 60 * 60 * 1000;
  const oneDay = 24 * oneHour;
  const oneWeek = 7 * oneDay;
  const oneMonth = 30 * oneDay;
  const oneYear = 365 * oneDay;
  const cutoffs: Record<TimeRange, number> = {
    hour: now - oneHour,
    today: now - oneDay,
    week: now - oneWeek,
    month: now - oneMonth,
    year: now - oneYear,
    all: 0,
  };
  const cutoff = cutoffs[range];
  return posts.filter((p) => new Date(p.createdAt).getTime() >= cutoff);
}

interface PostsSectionProps {
  timeRange?: TimeRange;
  onTimeRangeChange?: (r: TimeRange) => void;
}

export function PostsSection({ timeRange = "all", onTimeRangeChange }: PostsSectionProps) {
  const [sort, setSort] = useState<string>("new");
  const [shuffled, setShuffled] = useState(false);

  const filtered = useMemo(() => filterByTime(mockPosts, timeRange), [timeRange]);
  const displayed = useMemo(() => {
    if (sort === "random" || shuffled) {
      return [...filtered].sort(() => Math.random() - 0.5);
    }
    if (sort === "hot") return [...filtered].sort((a, b) => b.upvotes - a.upvotes);
    if (sort === "discussed") return [...filtered].sort((a, b) => b.commentCount - a.commentCount);
    return [...filtered].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
  }, [filtered, sort, shuffled]);

  return (
    <section>
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-zinc-100">📝 Posts</h2>
      </div>
      <div className="mb-2 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => setShuffled(!shuffled)}
          className={`pill ${shuffled ? "pill-active" : ""}`}
        >
          🎲 Shuffle
        </button>
        {(Object.keys(TIME_LABELS) as TimeRange[]).map((r) => (
          <button
            key={r}
            type="button"
            onClick={() => onTimeRangeChange?.(r)}
            className={`pill ${timeRange === r ? "pill-active" : ""}`}
          >
            {TIME_LABELS[r]}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        {SORTS.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => {
              setSort(s.id);
              if (s.id === "random") setShuffled(true);
            }}
            className={`pill ${sort === s.id ? "pill-active" : ""}`}
          >
            {s.label}
          </button>
        ))}
      </div>
      <div className="mt-4 space-y-3">
        {displayed.length === 0 ? (
          <div className="card py-8 text-center text-sm text-zinc-500">
            No posts yet.
          </div>
        ) : (
          displayed.map((post) => (
            <Link
              key={post.id}
              href={`/post/${post.id}`}
              className="card block transition hover:border-zinc-600"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <h3 className="font-medium text-zinc-200 line-clamp-1">
                    {post.title}
                  </h3>
                  {post.content && (
                    <p className="mt-1 text-sm text-zinc-500 line-clamp-2">
                      {post.content}
                    </p>
                  )}
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
                    <span>m/{post.submolt.name}</span>
                    <span>·</span>
                    <span>u/{post.author.name}</span>
                    <span>·</span>
                    <span>{post.upvotes} upvotes</span>
                    <span>·</span>
                    <span>{post.commentCount} comments</span>
                  </div>
                </div>
              </div>
            </Link>
          ))
        )}
      </div>
    </section>
  );
}
