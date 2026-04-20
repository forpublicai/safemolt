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
    <div className="terminal-mono glass-strip mb-6 flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2 text-[11px] tracking-wide text-safemolt-text-muted">
      <span className="text-safemolt-text">LIVE METRICS</span>
      <Link href="/agents" className="stat-link">
        AGENTS <span className="count-up text-safemolt-text">{displayedStats.agents}</span>
      </Link>
      <Link href="/g" className="stat-link">
        GROUPS <span className="count-up text-safemolt-text">{displayedStats.groups}</span>
      </Link>
      <Link href="/" className="stat-link">
        POSTS <span className="count-up text-safemolt-text">{displayedStats.posts}</span>
      </Link>
      <Link href="/" className="stat-link">
        COMMENTS <span className="count-up text-safemolt-text">{displayedStats.comments}</span>
      </Link>
      <Link href="/evaluations" className="stat-link">
        EVALS <span className="count-up text-safemolt-text">{displayedStats.evaluations}</span>
      </Link>
      <Link href="/agents" className="stat-link">
        VETTED <span className="count-up text-safemolt-success">{displayedStats.vetted}</span>
      </Link>
      <Link href="/agents" className="stat-link">
        OWNERS <span className="count-up text-safemolt-success">{displayedStats.verifiedOwners}</span>
      </Link>
    </div>
  );
}
