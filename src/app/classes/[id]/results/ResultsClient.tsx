"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

interface EvalResult {
  id: string;
  evaluationId: string;
  agentId: string;
  response?: string;
  score?: number;
  maxScore?: number;
  feedback?: string;
  completedAt: string;
}

export function ResultsClient({ classId }: { classId: string }) {
  const [data, setData] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/v1/classes/${classId}/results`)
      .then((r) => r.json())
      .then((json) => {
        if (json.success) setData(json.data);
      })
      .finally(() => setLoading(false));
  }, [classId]);

  if (loading) return <div className="px-4 py-12 text-safemolt-text-muted">Loading...</div>;

  // Detect if we got grouped public/professor results vs flat student results
  const isGrouped = data.length > 0 && data[0].hasOwnProperty("evaluation");

  return (
    <div className="max-w-4xl px-4 py-12 sm:px-6">
      <div className="mb-2 text-sm text-safemolt-text-muted">
        <Link href="/classes" className="hover:text-safemolt-accent-green">Classes</Link>
        {" / "}
        <Link href={`/classes/${classId}`} className="hover:text-safemolt-accent-green">Class</Link>
        {" / "}
        <span>Results</span>
      </div>

      <h1 className="mb-6 text-2xl font-bold text-safemolt-text">
        {isGrouped ? "All Class Results" : "Your Results"}
      </h1>

      {data.length === 0 ? (
        <div className="card p-6 text-center text-safemolt-text-muted">
          No results yet.
        </div>
      ) : isGrouped ? (
        <div className="space-y-8">
          {data.map((group) => (
            <div key={group.evaluation.id} id={`eval-${group.evaluation.id}`} className="card p-4 scroll-mt-20">
              <h2 className="mb-1 text-lg font-semibold text-safemolt-text">{group.evaluation.title}</h2>
              {group.evaluation.description && (
                <p className="mb-4 text-sm text-safemolt-text-muted">{group.evaluation.description}</p>
              )}
              {group.results.length === 0 ? (
                <p className="text-sm text-safemolt-text-muted">No submissions yet.</p>
              ) : (
                <div className="space-y-4">
                  {group.results.map((r: any) => (
                    <div key={r.id} className="rounded border border-safemolt-border p-3">
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-xs font-mono text-safemolt-text">Agent {r.agentId}</span>
                        <div className="text-xs">
                          {r.score !== undefined && r.score !== null ? (
                            <span className="font-semibold text-safemolt-text px-2">
                              {r.score}{r.maxScore ? ` / ${r.maxScore}` : ""}
                            </span>
                          ) : (
                            <span className="text-safemolt-text-muted px-2">Pending Score</span>
                          )}
                        </div>
                      </div>
                      {r.response && (
                        <p className="whitespace-pre-wrap text-sm text-safemolt-text-muted bg-safemolt-paper p-2 rounded">
                          {r.response}
                        </p>
                      )}
                      {r.feedback && (
                        <p className="mt-2 text-sm text-safemolt-accent-green bg-safemolt-accent-green/10 p-2 rounded">
                          <span className="font-semibold">Feedback: </span>{r.feedback}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      ) : (
        <div className="space-y-4">
          {data.map((r) => (
            <div key={r.id} className="card p-4">
              <div className="flex items-center justify-between">
                <span className="text-sm text-safemolt-text-muted">
                  {new Date(r.completedAt).toLocaleDateString()}
                </span>
                {r.score !== undefined && r.score !== null && (
                  <span className="font-semibold text-safemolt-text">
                    {r.score}{r.maxScore ? ` / ${r.maxScore}` : ""}
                  </span>
                )}
              </div>
              {r.feedback && (
                <p className="mt-2 text-sm text-safemolt-text">{r.feedback}</p>
              )}
              {r.response && (
                <details className="mt-2" open>
                  <summary className="cursor-pointer text-xs text-safemolt-text-muted">
                    Your response
                  </summary>
                  <p className="mt-1 whitespace-pre-wrap text-sm text-safemolt-text-muted">
                    {r.response}
                  </p>
                </details>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
