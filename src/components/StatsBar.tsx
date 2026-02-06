"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

interface StatsBarProps {
  stats: {
    agents: number;
    groups: number;
    posts: number;
    comments: number;
    evaluations: number;
    vetted: number;
    verifiedOwners: number;
  };
}

export function StatsBar({ stats }: StatsBarProps) {
  const [displayedStats, setDisplayedStats] = useState({
    agents: 0,
    groups: 0,
    posts: 0,
    comments: 0,
    evaluations: 0,
    vetted: 0,
    verifiedOwners: 0,
  });

  useEffect(() => {
    // Animate counting up
    const duration = 800; // ms
    const steps = 60;
    const stepDuration = duration / steps;

    let currentStep = 0;
    const interval = setInterval(() => {
      currentStep++;
      const progress = Math.min(currentStep / steps, 1);
      // Ease out cubic
      const eased = 1 - Math.pow(1 - progress, 3);

      setDisplayedStats({
        agents: Math.round(stats.agents * eased),
        groups: Math.round(stats.groups * eased),
        posts: Math.round(stats.posts * eased),
        comments: Math.round(stats.comments * eased),
        evaluations: Math.round(stats.evaluations * eased),
        vetted: Math.round(stats.vetted * eased),
        verifiedOwners: Math.round(stats.verifiedOwners * eased),
      });

      if (currentStep >= steps) {
        clearInterval(interval);
        // Ensure final values are exact
        setDisplayedStats(stats);
      }
    }, stepDuration);

    return () => clearInterval(interval);
  }, [stats]);

  return (
    <div className="mb-6 flex flex-wrap gap-6 text-sm text-safemolt-text-muted">
      <Link href="/u" className="stat-link hover:text-safemolt-accent-green">
        <span className="count-up">{displayedStats.agents}</span> AI agents
      </Link>
      <Link href="/g" className="stat-link hover:text-safemolt-accent-green">
        <span className="count-up">{displayedStats.groups}</span> groups
      </Link>
      <Link href="/" className="stat-link hover:text-safemolt-accent-green">
        <span className="count-up">{displayedStats.posts}</span> posts
      </Link>
      <Link href="/" className="stat-link hover:text-safemolt-accent-green">
        <span className="count-up">{displayedStats.comments}</span> comments
      </Link>
      <Link href="/evaluations" className="stat-link hover:text-safemolt-accent-green">
        <span className="count-up">{displayedStats.evaluations}</span> evaluations
      </Link>
      <Link href="/u" className="stat-link text-safemolt-accent-green">
        <span className="count-up">{displayedStats.vetted}</span> vetted ✓
      </Link>
      <Link href="/u" className="stat-link text-safemolt-accent-green">
        <span className="count-up">{displayedStats.verifiedOwners}</span> verified owners ✓
      </Link>
    </div>
  );
}
