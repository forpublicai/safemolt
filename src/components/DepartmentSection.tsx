"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Department } from "@/lib/evaluations/departments";
import { RevealOnScroll } from "@/components/RevealOnScroll";

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

interface DepartmentSectionProps {
  department: Department;
  evaluations: Evaluation[];
  stats: Record<string, EvaluationStats>;
}

export function DepartmentSection({ department, evaluations, stats }: DepartmentSectionProps) {
  const router = useRouter();
  const [expanded, setExpanded] = useState(false);

  // Sort evaluations by SIP number
  const sortedEvaluations = [...evaluations].sort((a, b) => a.sip - b.sip);
  
  // Show top 3 when collapsed, all when expanded
  const displayedEvaluations = expanded ? sortedEvaluations : sortedEvaluations.slice(0, 3);
  const remainingCount = sortedEvaluations.length - 3;

  if (evaluations.length === 0) {
    return null;
  }

  return (
    <div className="mb-8">
      {/* Department Header */}
      <div className="mb-4">
        <h2 className="text-xl font-semibold text-safemolt-text">
          {department.name}
        </h2>
        <p className="text-sm text-safemolt-text-muted mt-1">
          {department.description}
        </p>
      </div>

      {/* Evaluation List */}
      <div className="space-y-0.5">
        {displayedEvaluations.map((evaluation) => {
          // Filter out empty prerequisites
          const prerequisites = Array.isArray(evaluation.prerequisites) 
            ? evaluation.prerequisites.filter(p => p && typeof p === 'string' && p.trim().length > 0)
            : [];
          const hasPrerequisites = prerequisites.length > 0;
          const evaluationStats = stats[evaluation.id] || { passes: 0, total: 0 };
          
          return (
            <RevealOnScroll key={evaluation.id}>
              <div
                className="post-row dialog-box flex items-start gap-4 py-3 transition hover:bg-safemolt-paper/50 cursor-pointer"
                onClick={() => router.push(`/evaluations/${evaluation.sip}`)}
              >
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-safemolt-text">
                    {evaluation.name}
                    {evaluation.hasPassed && (
                      <span className="ml-2 text-xs text-safemolt-success">✓ Passed</span>
                    )}
                  </div>
                  <div className="text-sm text-safemolt-text-muted mt-0.5">
                    {evaluation.description}
                    {hasPrerequisites && (
                      <div className="mt-1 text-xs text-safemolt-text-muted">
                        Prerequisites: {prerequisites.join(', ')}
                      </div>
                    )}
                  </div>
                </div>
                <div className="shrink-0 w-32">
                  {evaluationStats.total > 0 ? (
                    <div>
                      <div className="text-sm text-safemolt-text-muted mb-1">
                        {evaluationStats.passes}/{evaluationStats.total} passing
                      </div>
                      <div className="progress-bar">
                        <div
                          className={`progress-bar-fill ${
                            evaluationStats.passes / evaluationStats.total >= 0.8
                              ? ''
                              : evaluationStats.passes / evaluationStats.total >= 0.5
                              ? 'medium'
                              : 'low'
                          }`}
                          style={{
                            width: `${(evaluationStats.passes / evaluationStats.total) * 100}%`,
                          }}
                        />
                      </div>
                    </div>
                  ) : (
                    <span className="text-sm text-safemolt-text-muted/60">—</span>
                  )}
                </div>
              </div>
            </RevealOnScroll>
          );
        })}
      </div>

      {/* Show More / Show Less Button */}
      {sortedEvaluations.length > 3 && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="mt-3 text-sm font-medium text-safemolt-accent-green hover:text-safemolt-accent-green-hover transition-colors"
          aria-expanded={expanded}
          aria-label={expanded ? `Collapse ${department.name} department` : `Expand ${department.name} department to show ${remainingCount} more`}
        >
          {expanded ? (
            "Show Less"
          ) : (
            `Show More (${remainingCount} more)`
          )}
        </button>
      )}
    </div>
  );
}
