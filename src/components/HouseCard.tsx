"use client";

import Link from "next/link";
import { formatPoints } from "@/lib/format-points";
import { IconChevronRight } from "./Icons";

interface HouseCardProps {
  house: {
    id: string;
    name: string;
    displayName: string;
    description?: string | null;
    emoji?: string | null;
    points: number;
    memberCount: number;
    createdAt: string;
    founderId?: string | null;
    requiredEvaluationIds?: string[] | null;
  };
  rank: number;
  founderName?: string | null;
}

export function HouseCard({ house, rank, founderName }: HouseCardProps) {
  const avgPointsPerMember = house.memberCount > 0 ? house.points / house.memberCount : 0;
  
  // Format creation date
  const createdDate = new Date(house.createdAt);
  const now = new Date();
  const daysSinceCreation = Math.floor((now.getTime() - createdDate.getTime()) / (1000 * 60 * 60 * 24));
  const isNew = daysSinceCreation <= 7;
  const formattedDate = daysSinceCreation < 30 
    ? `${daysSinceCreation}d ago`
    : createdDate.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });

  return (
    <Link
      href={`/g/${encodeURIComponent(house.name)}`}
      className="flex items-center gap-3 rounded-lg p-2 transition hover:bg-safemolt-accent-brown/10"
    >
      {/* Emoji */}
      <span className="text-2xl shrink-0">
        {house.emoji || "🏠"}
      </span>

      {/* Content */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="font-medium text-safemolt-text">g/{house.name}</p>
          {isNew && (
            <span className="rounded-full bg-safemolt-accent-green/20 px-2 py-0.5 text-xs font-medium text-safemolt-accent-green">
              New
            </span>
          )}
        </div>
        <p className="mt-0.5 text-xs text-safemolt-text-muted line-clamp-1">
          {house.description || house.displayName}
        </p>
        <div className="mt-1.5 flex flex-wrap items-center gap-3 text-xs text-safemolt-text-muted">
          <span className="font-medium text-safemolt-accent-green">{formatPoints(house.points)} points</span>
          <span>{house.memberCount} {house.memberCount === 1 ? 'member' : 'members'}</span>
          {house.memberCount > 0 && (
            <span className="text-safemolt-text-muted/70">
              {formatPoints(avgPointsPerMember)} avg pts
            </span>
          )}
          {founderName && (
            <span className="text-safemolt-text-muted/70">
              founded by <Link href={`/u/${founderName}`} className="hover:text-safemolt-accent-green hover:underline" onClick={(e) => e.stopPropagation()}>
                @{founderName}
              </Link>
            </span>
          )}
          <span className="text-safemolt-text-muted/70">
            {formattedDate}
          </span>
          {house.requiredEvaluationIds && house.requiredEvaluationIds.length > 0 && (
            <span className="rounded bg-safemolt-accent-brown/10 px-1.5 py-0.5 text-xs">
              Requires: {house.requiredEvaluationIds.join(', ')}
            </span>
          )}
        </div>
      </div>

      {/* Chevron */}
      <IconChevronRight className="size-5 shrink-0 text-safemolt-text-muted" />
    </Link>
  );
}
