"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type { ActivityItem, ActivityLinkType } from "@/lib/activity";

interface ActivityTrailProps {
  activities: ActivityItem[];
}

const filters = [
  { id: "post", label: "post" },
  { id: "comment", label: "comment" },
  { id: "playground", label: "playground" },
  { id: "classes", label: "classes" },
  { id: "evaluations", label: "evaluations" },
];

const linkClass: Record<ActivityLinkType, string> = {
  agent: "activity-link-agent",
  evaluation: "activity-link-evaluation",
  post: "activity-link-post",
  playground: "activity-link-playground",
  class: "activity-link-class",
  group: "activity-link-group",
};

export function ActivityTrail({ activities: initialActivities }: ActivityTrailProps) {
  const [activities, setActivities] = useState<ActivityItem[]>(() => sortAscending(initialActivities));
  const [expanded, setExpanded] = useState<string | null>(() => {
    const sorted = sortAscending(initialActivities);
    const newest = sorted[sorted.length - 1];
    return newest ? activityKey(newest) : null;
  });
  const [query, setQuery] = useState("");
  const [activeFilters, setActiveFilters] = useState<string[]>([]);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const streamRef = useRef<HTMLDivElement | null>(null);
  const debounceRef = useRef<number | null>(null);

  useEffect(() => {
    const stream = streamRef.current;
    if (stream) stream.scrollTop = stream.scrollHeight;
  }, []);

  useEffect(() => {
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => {
      void loadFresh();
    }, 180);
    return () => {
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
    };
  }, [query, activeFilters.join(",")]);

  const oldest = activities[0]?.occurredAt;

  async function fetchActivities(options: { before?: string } = {}) {
    const params = new URLSearchParams();
    params.set("limit", "40");
    if (options.before) params.set("before", options.before);
    if (query.trim()) params.set("q", query.trim());
    if (activeFilters.length > 0) params.set("types", activeFilters.join(","));

    const response = await fetch(`/api/activity?${params.toString()}`, { cache: "no-store" });
    const data = await response.json();
    if (!response.ok || !data.success) throw new Error(data.error ?? "Could not load activity");
    return {
      items: sortAscending((data.activities ?? []) as ActivityItem[]),
      hasMore: Boolean(data.has_more),
    };
  }

  async function loadFresh() {
    const stream = streamRef.current;
    const { items, hasMore: more } = await fetchActivities();
    setActivities(items);
    setHasMore(more);
    const newest = items[items.length - 1];
    setExpanded(newest ? activityKey(newest) : null);
    requestAnimationFrame(() => {
      if (stream) stream.scrollTop = stream.scrollHeight;
    });
  }

  async function loadOlder() {
    if (!oldest || loadingOlder || !hasMore) return;
    const stream = streamRef.current;
    const previousHeight = stream?.scrollHeight ?? 0;
    setLoadingOlder(true);
    try {
      const { items, hasMore: more } = await fetchActivities({ before: oldest });
      setHasMore(more);
      if (items.length > 0) {
        setActivities((current) => mergeActivities(items, current));
        requestAnimationFrame(() => {
          if (stream) stream.scrollTop = stream.scrollHeight - previousHeight;
        });
      }
    } finally {
      setLoadingOlder(false);
    }
  }

  function onStreamScroll() {
    const stream = streamRef.current;
    if (!stream || stream.scrollTop > 28) return;
    void loadOlder();
  }

  function toggleFilter(id: string) {
    setActiveFilters((current) =>
      current.includes(id) ? current.filter((value) => value !== id) : [...current, id]
    );
  }

  const emptyLabel = useMemo(() => {
    if (query || activeFilters.length > 0) return "[No activity matches this filter]";
    return "[No public activity yet]";
  }, [query, activeFilters.length]);

  return (
    <div className="activity-frame">
      <div ref={streamRef} className="activity-stream" onScroll={onStreamScroll}>
        {loadingOlder && <p className="activity-load-state">[Loading earlier activity...]</p>}
        {activities.length === 0 ? (
          <p className="activity-empty">{emptyLabel}</p>
        ) : (
          activities.map((activity) => (
            <ActivityRow
              key={activityKey(activity)}
              activity={activity}
              isExpanded={expanded === activityKey(activity)}
              onToggle={() => {
                const key = activityKey(activity);
                setExpanded((current) => (current === key ? null : key));
              }}
            />
          ))
        )}
      </div>
      <div className="activity-controls">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="activity-search"
          placeholder="search activity"
          aria-label="Search activity"
        />
        <div className="activity-filter-list" aria-label="Activity type filters">
          {filters.map((filter) => (
            <button
              key={filter.id}
              type="button"
              className={activeFilters.includes(filter.id) ? "activity-filter active" : "activity-filter"}
              onClick={() => toggleFilter(filter.id)}
            >
              {filter.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function ActivityRow({
  activity,
  isExpanded,
  onToggle,
}: {
  activity: ActivityItem;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const [context, setContext] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle() {
    onToggle();
    if (context || loading) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/activity/${encodeURIComponent(activity.kind)}/${encodeURIComponent(activity.id)}/context`,
        { cache: "no-store" }
      );
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error ?? "Context unavailable");
      setContext(String(data.content ?? ""));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Context unavailable");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="activity-row">
      <div
        role="button"
        tabIndex={0}
        onClick={toggle}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            toggle();
          }
        }}
        className="activity-line"
        aria-expanded={isExpanded}
      >
        <span className="activity-date">[{activity.timestampLabel}]</span>{" "}
        {activity.segments.map((segment, index) => {
          if (segment.type === "text") return <span key={index}>{segment.text}</span>;
          return (
            <Link
              key={index}
              href={segment.href}
              className={linkClass[segment.linkType]}
              onClick={(event) => event.stopPropagation()}
            >
              {segment.text}
            </Link>
          );
        })}
      </div>
      {isExpanded && (
        <div className="activity-context">
          {loading ? "[Generating context...]" : error ? `[${error}]` : context || activity.summary}
        </div>
      )}
    </div>
  );
}

function activityKey(activity: ActivityItem): string {
  return `${activity.kind}:${activity.id}`;
}

function sortAscending(items: ActivityItem[]): ActivityItem[] {
  return [...items].sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));
}

function mergeActivities(older: ActivityItem[], current: ActivityItem[]): ActivityItem[] {
  const seen = new Set(current.map(activityKey));
  return [...older.filter((item) => !seen.has(activityKey(item))), ...current];
}
