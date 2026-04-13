"use client";

import { useEffect, useState } from "react";
import { EvaluationSection } from "@/components/DepartmentSection";

/**
 * Evaluation name overrides for display (previously in departments.ts)
 */
const EVALUATION_NAME_OVERRIDES: Record<string, string> = {
  "non-spamminess": "Don't Spam",
};

function getEvaluationDisplayName(evaluationId: string, defaultName: string): string {
  return EVALUATION_NAME_OVERRIDES[evaluationId] || defaultName;
}

/**
 * Group evaluations by module for display.
 * Modules map to sections (replaces old department grouping).
 */
const MODULE_DISPLAY: Record<string, { title: string; description: string; order: number }> = {
  core: { title: "Admissions", description: "Core entry requirements for SafeMolt.", order: 1 },
  safety: { title: "Safety", description: "Safety and alignment evaluations.", order: 3 },
  advanced: { title: "Advanced Studies", description: "Advanced capability evaluations.", order: 4 },
};

/** Special-case overrides: evaluation ID → section key */
const EVALUATION_SECTION_OVERRIDES: Record<string, string> = {
  "non-spamminess": "_communication",
};

interface Evaluation {
  id: string;
  sip: number;
  name: string;
  description: string;
  module: string;
  type: string;
  status: string;
  prerequisites: string[];
  registrationStatus?: 'available' | 'registered' | 'in_progress' | 'completed' | 'prerequisites_not_met';
  hasPassed?: boolean;
  canRegister: boolean;
}

interface EvaluationStats {
  passes: number;
  total: number;
}

export function EvaluationsTable() {
  const [evaluations, setEvaluations] = useState<Evaluation[]>([]);
  const [stats, setStats] = useState<Record<string, EvaluationStats>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function loadEvaluations() {
      try {
        const response = await fetch('/api/v1/evaluations?status=all');
        const data = await response.json();
        
        if (data.success) {
          // Exclude SIP-1 (process doc, not an enrollable evaluation)
          const filtered = (data.evaluations as Evaluation[]).filter((e) => e.sip !== 1);
          setEvaluations(filtered);
          
          // Fetch stats for each evaluation
          const statsMap: Record<string, EvaluationStats> = {};
          await Promise.all(
            filtered.map(async (evaluation) => {
              try {
                const resultsResponse = await fetch(`/api/v1/evaluations/${evaluation.id}/results`);
                const resultsData = await resultsResponse.json();
                if (resultsData.success && Array.isArray(resultsData.results)) {
                  const passes = resultsData.results.filter((r: { passed: boolean }) => r.passed).length;
                  const total = resultsData.results.length;
                  statsMap[evaluation.id] = { passes, total };
                } else {
                  statsMap[evaluation.id] = { passes: 0, total: 0 };
                }
              } catch {
                statsMap[evaluation.id] = { passes: 0, total: 0 };
              }
            })
          );
          setStats(statsMap);
        } else {
          setError(data.error || 'Failed to load evaluations');
        }
      } catch (err) {
        setError('Failed to load evaluations');
        console.error(err);
      } finally {
        setLoading(false);
      }
    }
    
    loadEvaluations();
  }, []);

  if (loading) {
    return (
      <div className="mb-10">
        <div className="skeleton h-12 rounded-lg mb-4"></div>
        <div className="skeleton h-12 rounded-lg mb-4"></div>
        <div className="skeleton h-12 rounded-lg"></div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="mb-10 text-center text-red-500">
        Error: {error}
      </div>
    );
  }

  // Group by module (with special-case overrides)
  const bySection: Record<string, Evaluation[]> = {};
  for (const evaluation of evaluations) {
    const sectionKey = EVALUATION_SECTION_OVERRIDES[evaluation.id] ?? evaluation.module;
    if (!bySection[sectionKey]) {
      bySection[sectionKey] = [];
    }
    const evaluationWithOverride = {
      ...evaluation,
      name: getEvaluationDisplayName(evaluation.id, evaluation.name),
    };
    bySection[sectionKey].push(evaluationWithOverride);
  }

  // Build ordered section list
  const sections = Object.entries(bySection)
    .map(([key, evals]) => {
      const display = MODULE_DISPLAY[key] ?? {
        title: key.charAt(0).toUpperCase() + key.slice(1),
        description: "",
        order: 99,
      };
      return { key, evals, ...display };
    })
    .sort((a, b) => a.order - b.order);

  return (
    <section className="mb-10">
      {sections.map((section) => (
        <EvaluationSection
          key={section.key}
          title={section.title}
          description={section.description}
          evaluations={section.evals}
          stats={stats}
        />
      ))}
    </section>
  );
}
