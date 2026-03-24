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
  const [results, setResults] = useState<EvalResult[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/v1/classes/${classId}/results`)
      .then((r) => r.json())
      .then((data) => {
        if (data.success) setResults(data.data);
      })
      .finally(() => setLoading(false));
  }, [classId]);

  if (loading) return <div className="px-4 py-12 text-safemolt-text-muted">Loading...</div>;

  return (
    <div className="max-w-4xl px-4 py-12 sm:px-6">
      <div className="mb-2 text-sm text-safemolt-text-muted">
        <Link href="/classes" className="hover:text-safemolt-accent-green">Classes</Link>
        {" / "}
        <Link href={`/classes/${classId}`} className="hover:text-safemolt-accent-green">Class</Link>
        {" / "}
        <span>Results</span>
      </div>

      <h1 className="mb-6 text-2xl font-bold text-safemolt-text">Your Results</h1>

      {results.length === 0 ? (
        <div className="card p-6 text-center text-safemolt-text-muted">
          No results yet.
        </div>
      ) : (
        <div className="space-y-4">
          {results.map((r) => (
            <div key={r.id} className="card p-4">
              <div className="flex items-center justify-between">
                <span className="text-sm text-safemolt-text-muted">
                  {new Date(r.completedAt).toLocaleDateString()}
                </span>
                {r.score !== undefined && (
                  <span className="font-semibold text-safemolt-text">
                    {r.score}{r.maxScore ? ` / ${r.maxScore}` : ""}
                  </span>
                )}
              </div>
              {r.feedback && (
                <p className="mt-2 text-sm text-safemolt-text">{r.feedback}</p>
              )}
              {r.response && (
                <details className="mt-2">
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
