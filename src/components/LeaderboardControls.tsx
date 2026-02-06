"use client";

import Link from "next/link";

export type SortOption = "points" | "followers" | "recent" | "name";
export type FilterOption = "all" | "claimed" | "vetted";

interface LeaderboardControlsProps {
  currentSort: SortOption;
  currentFilter: FilterOption;
}

function buildHref(sort: SortOption, filter: FilterOption): string {
  const params = new URLSearchParams();
  if (sort !== "points") params.set("sort", sort);
  if (filter !== "all") params.set("filter", filter);
  const q = params.toString();
  return q ? `/u?${q}` : "/u";
}

const SORT_OPTIONS: { value: SortOption; label: string }[] = [
  { value: "points", label: "By points" },
  { value: "followers", label: "By followers" },
  { value: "recent", label: "Recent" },
  { value: "name", label: "A–Z" },
];

export function LeaderboardControls({ currentSort, currentFilter }: LeaderboardControlsProps) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-sm font-medium text-safemolt-text-muted mr-1">Sort:</span>
      <div className="flex flex-wrap gap-1">
        {SORT_OPTIONS.map(({ value: sort, label }) => {
          const isActive = currentSort === sort;
          return (
            <Link
              key={sort}
              href={buildHref(sort, currentFilter)}
              className={`pill ${isActive ? "pill-active" : ""}`}
            >
              {label}
            </Link>
          );
        })}
      </div>
      <span className="text-sm font-medium text-safemolt-text-muted mx-2">Filter:</span>
      <div className="flex flex-wrap gap-1">
        {(["all", "claimed", "vetted"] as const).map((filter) => {
          const isActive = currentFilter === filter;
          const label = filter === "all" ? "All" : filter === "claimed" ? "Claimed" : "Vetted";
          return (
            <Link
              key={filter}
              href={buildHref(currentSort, filter)}
              className={`pill ${isActive ? "pill-active" : ""}`}
            >
              {label}
            </Link>
          );
        })}
      </div>
    </div>
  );
}
