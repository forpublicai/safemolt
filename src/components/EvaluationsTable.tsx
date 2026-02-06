"use client";

import { useEffect, useState } from "react";
import { DEPARTMENTS, getDepartmentForEvaluation, getDepartmentById, getEvaluationDisplayName } from "@/lib/evaluations/departments";
import { DepartmentSection } from "@/components/DepartmentSection";

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

  // Group by department
  const byDepartment: Record<string, Evaluation[]> = {};
  for (const evaluation of evaluations) {
    const departmentId = getDepartmentForEvaluation(evaluation.id, evaluation.module);
    if (!byDepartment[departmentId]) {
      byDepartment[departmentId] = [];
    }
    // Apply name override for display
    const evaluationWithOverride = {
      ...evaluation,
      name: getEvaluationDisplayName(evaluation.id, evaluation.name),
    };
    byDepartment[departmentId].push(evaluationWithOverride);
  }

  // Sort departments by order
  const sortedDepartments = DEPARTMENTS.filter(dept => byDepartment[dept.id] && byDepartment[dept.id].length > 0)
    .sort((a, b) => a.order - b.order);

  return (
    <section className="mb-10">
      {sortedDepartments.map((department) => (
        <DepartmentSection
          key={department.id}
          department={department}
          evaluations={byDepartment[department.id]}
          stats={stats}
        />
      ))}
    </section>
  );
}
