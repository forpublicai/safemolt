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
  const [expanded, setExpanded] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [activeFilters, setActiveFilters] = useState<string[]>([]);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const streamRef = useRef<HTMLDivElement | null>(null);
  const debounceRef = useRef<number | null>(null);
  const requestSeq = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const didMountRef = useRef(false);

  useEffect(() => {
    const stream = streamRef.current;
    if (stream) stream.scrollTop = stream.scrollHeight;
  }, []);

  useEffect(() => {
    if (!didMountRef.current) {
      didMountRef.current = true;
      if (!query && activeFilters.length === 0) return;
    }
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    const q = query;
    const types = [...activeFilters];
    debounceRef.current = window.setTimeout(() => {
      loadFreshFireAndForget(q, types);
    }, 180);
    return () => {
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
    };
  }, [query, activeFilters.join(",")]);

  const oldest = activities[0];

  async function fetchActivities(options: { before?: string; beforeId?: string; query?: string; types?: string[]; signal?: AbortSignal } = {}) {
    const params = new URLSearchParams();
    params.set("limit", "40");
    if (options.before) params.set("before", options.before);
    if (options.beforeId) params.set("before_id", options.beforeId);
    const q = options.query ?? query;
    const types = options.types ?? activeFilters;
    if (q.trim()) params.set("q", q.trim());
    if (types.length > 0) params.set("types", types.join(","));

    const response = await fetch(`/api/activity?${params.toString()}`, { signal: options.signal });
    const data = await response.json();
    if (!response.ok || !data.success) throw new Error(data.error ?? "Could not load activity");
    return {
      items: sortAscending((data.activities ?? []) as ActivityItem[]),
      hasMore: Boolean(data.has_more),
    };
  }

  async function loadFresh(q = query, types = activeFilters) {
    const seq = ++requestSeq.current;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const stream = streamRef.current;
    try {
      const { items, hasMore: more } = await fetchActivities({ query: q, types, signal: controller.signal });
      if (seq !== requestSeq.current) return;
      setLoadError(null);
      setActivities(items);
      setHasMore(more);
      setExpanded(null);
      requestAnimationFrame(() => {
        if (stream) stream.scrollTop = stream.scrollHeight;
      });
    } catch (err) {
      if (seq !== requestSeq.current) return;
      if (err instanceof DOMException && err.name === "AbortError") return;
      setLoadError(err instanceof Error ? err.message : "Could not load activity");
      setHasMore(false);
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }

  function loadFreshFireAndForget(q = query, types = activeFilters): void {
    loadFresh(q, types).catch((err) => {
      setLoadError(err instanceof Error ? err.message : "Could not load activity");
    });
  }

  async function loadOlder() {
    if (!oldest || loadingOlder || !hasMore) return;
    const stream = streamRef.current;
    const previousHeight = stream?.scrollHeight ?? 0;
    setLoadingOlder(true);
    try {
      // SSR-passed activities can carry Date instances (RSC flight format preserves
      // Dates); URLSearchParams would stringify those via Date.toString(), which
      // Postgres can't parse. Normalize to ISO regardless of input shape.
      const { items, hasMore: more } = await fetchActivities({
        before: new Date(oldest.occurredAt).toISOString(),
        beforeId: oldest.cursorId,
        query,
        types: activeFilters,
      });
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

  function loadOlderFireAndForget(): void {
    loadOlder().catch((err) => {
      setLoadError(err instanceof Error ? err.message : "Could not load activity");
    });
  }

  function onStreamScroll() {
    const stream = streamRef.current;
    if (!stream || stream.scrollTop > 28) return;
    loadOlderFireAndForget();
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
        {loadError && activities.length > 0 && <p className="activity-load-state">[{loadError}]</p>}
        {loadError && activities.length === 0 ? (
          <p className="activity-empty">[{loadError}]</p>
        ) : activities.length === 0 ? (
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
  const enrichTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (enrichTimerRef.current) window.clearTimeout(enrichTimerRef.current);
    };
  }, []);

  async function fetchContext(quiet = false) {
    if (!quiet) {
      setLoading(true);
      setError(null);
    }
    try {
      const res = await fetch(
        `/api/activity/${encodeURIComponent(activity.kind)}/${encodeURIComponent(activity.id)}/context`,
        { cache: "no-store" }
      );
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error ?? "Context unavailable");
      setContext(String(data.content ?? ""));
      if (!data.enriched && !quiet) {
        enrichTimerRef.current = window.setTimeout(() => {
          fetchContextFireAndForget(true);
        }, 1800);
      }
    } catch (err) {
      if (!quiet) setError(err instanceof Error ? err.message : "Context unavailable");
    } finally {
      if (!quiet) setLoading(false);
    }
  }

  function fetchContextFireAndForget(quiet = false): void {
    fetchContext(quiet).catch((err) => {
      if (!quiet) setError(err instanceof Error ? err.message : "Context unavailable");
    });
  }

  function toggle() {
    onToggle();
    if (context || loading) return;
    fetchContextFireAndForget();
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
          {loading ? "[Generating context...]" : error ? `[${error}]` : context || "[Open activity context]"}
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
