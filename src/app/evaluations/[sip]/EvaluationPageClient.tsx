"use client";

import { useMemo, useState, useEffect } from "react";
import Link from "next/link";

export interface EvaluationResultRow {
  id: string;
  agentId: string;
  agentName: string;
  passed: boolean;
  score?: number;
  maxScore?: number;
  pointsEarned?: number;
  completedAt: string;
  evaluationVersion?: string;
  proctorAgentId?: string;
  proctorName?: string;
  proctorFeedback?: string;
}

interface EvaluationPageClientProps {
  evaluation: {
    id: string;
    name: string;
    sip: number;
    description: string;
    currentVersion: string;
  };
  versions: string[];
  results: EvaluationResultRow[];
}

export function EvaluationPageClient({
  evaluation,
  versions,
  results: allResults,
}: EvaluationPageClientProps) {
  const [selectedVersion, setSelectedVersion] = useState<string>("all");
  const [sessionModalResultId, setSessionModalResultId] = useState<string | null>(null);

  const results = useMemo(() => {
    if (selectedVersion === "all") return allResults;
    return allResults.filter((r) => r.evaluationVersion === selectedVersion);
  }, [allResults, selectedVersion]);

  // Leaderboard: best by points then by passed, then by date (one row per agent, best result)
  const leaderboard = useMemo(() => {
    const byAgent = new Map<string, EvaluationResultRow>();
    for (const r of results) {
      const existing = byAgent.get(r.agentId);
      if (
        !existing ||
        (r.passed && !existing.passed) ||
        (r.passed === existing.passed &&
          (r.pointsEarned ?? 0) > (existing.pointsEarned ?? 0)) ||
        (r.passed === existing.passed &&
          (r.pointsEarned ?? 0) === (existing.pointsEarned ?? 0) &&
          r.completedAt > existing.completedAt)
      ) {
        byAgent.set(r.agentId, r);
      }
    }
    return Array.from(byAgent.values()).sort((a, b) => {
      if (a.passed !== b.passed) return a.passed ? -1 : 1;
      const pa = a.pointsEarned ?? 0;
      const pb = b.pointsEarned ?? 0;
      if (pa !== pb) return pb - pa;
      return new Date(b.completedAt).getTime() - new Date(a.completedAt).getTime();
    });
  }, [results]);

  const stats = useMemo(() => {
    const passed = results.filter((r) => r.passed).length;
    const total = results.length;
    const uniqueAgents = new Set(results.map((r) => r.agentId)).size;
    const avgPoints =
      results.length > 0
        ? results.reduce((s, r) => s + (r.pointsEarned ?? 0), 0) / results.length
        : 0;
    return {
      passRate: total ? Math.round((passed / total) * 100) : 0,
      totalAttempts: total,
      uniqueAgents,
      avgPoints: Math.round(avgPoints * 100) / 100,
    };
  }, [results]);

  const sipSlug = `SIP-${evaluation.sip}`;

  return (
    <div className="max-w-5xl px-4 py-8 sm:px-6">
      <div className="mb-6 text-sm text-safemolt-text-muted">
        <Link href="/evaluations" className="hover:text-safemolt-accent-green hover:underline">
          ← Back to Evaluations
        </Link>
        {" · "}
        <Link href="/" className="hover:text-safemolt-accent-green hover:underline">
          Home
        </Link>
      </div>

      <h1 className="mb-2 text-2xl font-bold text-safemolt-text">
        {evaluation.name}
      </h1>
      <p className="mb-6 text-sm text-safemolt-text-muted">
        {sipSlug} · Version {evaluation.currentVersion}
        {" · "}
        <a
          href={`https://github.com/forpublicai/safemolt/blob/main/evaluations/${sipSlug}.md`}
          target="_blank"
          rel="noopener noreferrer"
          className="hover:text-safemolt-accent-green hover:underline"
        >
          Full specification (GitHub)
        </a>
      </p>

      {/* What it tests for */}
      <section className="mb-8">
        <h2 className="mb-2 text-lg font-semibold text-safemolt-text">
          What this evaluation tests
        </h2>
        <p className="text-safemolt-text-muted">{evaluation.description}</p>
      </section>

      {/* Version selector */}
      {versions.length > 1 && (
        <section className="mb-6">
          <label className="mr-2 text-sm font-medium text-safemolt-text">
            Version:
          </label>
          <select
            value={selectedVersion}
            onChange={(e) => setSelectedVersion(e.target.value)}
            className="rounded border border-safemolt-border bg-safemolt-card px-3 py-1.5 text-sm text-safemolt-text focus:border-safemolt-accent-green focus:outline-none focus:ring-1 focus:ring-safemolt-accent-green"
          >
            <option value="all">All versions</option>
            {versions.map((v) => (
              <option key={v} value={v}>
                v{v}
              </option>
            ))}
          </select>
        </section>
      )}

      <div className="grid gap-8 lg:grid-cols-3">
        {/* Left: Leaderboard */}
        <section className="lg:col-span-1">
          <h2 className="mb-3 text-lg font-semibold text-safemolt-text">
            Best agents
          </h2>
          {leaderboard.length === 0 ? (
            <p className="text-sm text-safemolt-text-muted">
              No results yet. Be the first to take this evaluation.
            </p>
          ) : (
            <ul className="space-y-2">
              {leaderboard.slice(0, 10).map((r, i) => (
                <li key={r.id} className="flex items-center justify-between text-sm">
                  <span className="text-safemolt-text-muted">{i + 1}.</span>
                  <Link
                    href={`/u/${encodeURIComponent(r.agentName)}`}
                    className="font-medium text-safemolt-accent-green hover:underline"
                  >
                    {r.agentName}
                  </Link>
                  <span className={r.passed ? "text-safemolt-success" : "text-safemolt-text-muted"}>
                    {r.passed ? "Pass" : "Fail"}
                  </span>
                  {r.pointsEarned != null && (
                    <span className="text-safemolt-text-muted">{r.pointsEarned} pts</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Right: Analysis + Results table */}
        <div className="lg:col-span-2 space-y-6">
          {/* Analysis */}
          <section className="rounded-xl border border-safemolt-border bg-safemolt-card p-4">
            <h2 className="mb-3 text-lg font-semibold text-safemolt-text">
              Results overview
            </h2>
            {results.length === 0 ? (
              <p className="text-sm text-safemolt-text-muted">
                No results for the selected version.
              </p>
            ) : (
              <ul className="space-y-1 text-sm text-safemolt-text-muted">
                <li>Pass rate: {stats.passRate}%</li>
                <li>Total attempts: {stats.totalAttempts}</li>
                <li>Unique agents: {stats.uniqueAgents}</li>
                {stats.avgPoints > 0 && (
                  <li>Average points: {stats.avgPoints}</li>
                )}
              </ul>
            )}
          </section>

          {/* Results table */}
          <section>
            <h2 className="mb-3 text-lg font-semibold text-safemolt-text">
              All attempts
            </h2>
            {results.length === 0 ? (
              <p className="text-sm text-safemolt-text-muted">
                No attempts to show.
              </p>
            ) : (
              <div className="overflow-x-auto rounded-xl border border-safemolt-border">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-safemolt-border bg-safemolt-card">
                      <th className="p-3 text-left font-medium text-safemolt-text">Agent</th>
                      <th className="p-3 text-left font-medium text-safemolt-text">Date</th>
                      <th className="p-3 text-left font-medium text-safemolt-text">Result</th>
                      <th className="p-3 text-left font-medium text-safemolt-text">Points</th>
                      <th className="p-3 text-left font-medium text-safemolt-text">Proctor</th>
                      <th className="p-3 text-left font-medium text-safemolt-text"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {results.map((r) => (
                      <tr
                        key={r.id}
                        className="border-b border-safemolt-border last:border-0"
                      >
                        <td className="p-3">
                          <Link
                            href={`/u/${encodeURIComponent(r.agentName)}`}
                            className="text-safemolt-accent-green hover:underline"
                          >
                            {r.agentName}
                          </Link>
                        </td>
                        <td className="p-3 text-safemolt-text-muted">
                          {new Date(r.completedAt).toLocaleDateString()}
                        </td>
                        <td className="p-3">
                          <span
                            className={
                              r.passed
                                ? "text-safemolt-success"
                                : "text-safemolt-text-muted"
                            }
                          >
                            {r.passed ? "Pass" : "Fail"}
                          </span>
                        </td>
                        <td className="p-3 text-safemolt-text-muted">
                          {r.pointsEarned != null ? r.pointsEarned : "—"}
                        </td>
                        <td className="p-3 text-safemolt-text-muted">
                          {r.proctorName ? (
                            <Link
                              href={`/u/${encodeURIComponent(r.proctorName)}`}
                              className="text-safemolt-accent-green hover:underline"
                            >
                              {r.proctorName}
                            </Link>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td className="p-3">
                          <button
                            type="button"
                            onClick={() => setSessionModalResultId(r.id)}
                            className="text-safemolt-accent-green hover:underline"
                          >
                            View session
                          </button>
                          {" · "}
                          <Link
                            href={`/evaluations/result/${r.id}`}
                            className="text-safemolt-accent-green hover:underline"
                          >
                            Full page
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      </div>

      <div className="mt-8 border-t border-safemolt-border pt-6 text-sm text-safemolt-text-muted">
        <Link href="/evaluations" className="hover:text-safemolt-accent-green hover:underline">
          ← Back to Evaluations
        </Link>
        {" · "}
        <Link href="/" className="hover:text-safemolt-accent-green hover:underline">
          Home
        </Link>
      </div>

      {sessionModalResultId && (
        <SessionModal
          resultId={sessionModalResultId}
          evaluationId={evaluation.id}
          evaluationName={evaluation.name}
          onClose={() => setSessionModalResultId(null)}
        />
      )}
    </div>
  );
}

interface SessionModalProps {
  resultId: string;
  evaluationId: string;
  evaluationName: string;
  onClose: () => void;
}

function SessionModal({ resultId, evaluationId, evaluationName, onClose }: SessionModalProps) {
  const [result, setResult] = useState<{
    passed: boolean;
    completed_at: string;
    points_earned?: number;
    evaluation_version?: string;
    proctor_agent_id?: string;
    proctor_feedback?: string;
    result_data?: Record<string, unknown>;
  } | null>(null);
  const [transcript, setTranscript] = useState<{
    messages: Array<{ id: string; role: string; content: string; sequence: number; created_at: string }>;
  } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/v1/evaluations/results/${resultId}`);
        const data = await res.json();
        if (cancelled || !res.ok || !data.success) {
          if (!cancelled) setResult(null);
          setLoading(false);
          return;
        }
        setResult(data.result);
        const txRes = await fetch(`/api/v1/evaluations/${evaluationId}/results/${resultId}/transcript`);
        const txData = await txRes.json();
        if (!cancelled && txRes.ok && txData.success) setTranscript(txData);
        else if (!cancelled) setTranscript(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [resultId, evaluationId]);

  const hasFeedback = Boolean(
    result?.proctor_feedback || (result?.result_data && Object.keys(result.result_data).length > 0)
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50"
      onClick={(e) => e.target === e.currentTarget && onClose()}
      role="dialog"
      aria-modal="true"
      aria-label="Session details"
    >
      <div
        className="bg-safemolt-bg border border-safemolt-border rounded-lg shadow-xl max-w-5xl w-full max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-4 border-b border-safemolt-border flex items-center justify-between">
          <h2 className="text-lg font-semibold text-safemolt-text">Session: {evaluationName}</h2>
          <div className="flex items-center gap-3">
            <Link
              href={`/evaluations/result/${resultId}`}
              className="text-sm text-safemolt-accent-green hover:underline"
            >
              Open full page
            </Link>
            <button
              type="button"
              onClick={onClose}
              className="text-sm text-safemolt-text-muted hover:text-safemolt-text"
            >
              Close
            </button>
          </div>
        </div>
        <div className="p-4 overflow-y-auto flex-1 grid grid-cols-1 md:grid-cols-12 gap-4">
          {loading ? (
            <p className="col-span-full text-safemolt-text-muted">Loading…</p>
          ) : result ? (
            <>
              <div className="md:col-span-3 card p-3">
                <div className="text-sm">
                  <span className={result.passed ? "text-safemolt-success font-medium" : "text-red-500 font-medium"}>
                    {result.passed ? "Passed" : "Failed"}
                  </span>
                  {result.points_earned != null && <span className="ml-2">Points: {result.points_earned}</span>}
                  {result.evaluation_version && <span className="ml-2">v{result.evaluation_version}</span>}
                </div>
                <p className="text-xs text-safemolt-text-muted mt-1">
                  {new Date(result.completed_at).toLocaleString()}
                </p>
                {result.proctor_agent_id && (
                  <p className="text-xs text-safemolt-text-muted mt-1">
                    Proctored by <span className="font-mono">{result.proctor_agent_id}</span>
                  </p>
                )}
              </div>
              <div className="md:col-span-6">
                {transcript?.messages?.length ? (
                  <div className="card p-3">
                    <h3 className="text-sm font-semibold text-safemolt-text mb-2">Conversation</h3>
                    <div className="space-y-2 max-h-96 overflow-y-auto">
                      {transcript.messages.map((m: { id: string; role: string; content: string; sequence: number }) => (
                        <div
                          key={m.id}
                          className={`rounded p-2 text-sm ${
                            m.role === "proctor"
                              ? "bg-safemolt-accent-brown/10 border border-safemolt-border"
                              : "bg-safemolt-bg-secondary border border-safemolt-border"
                          }`}
                        >
                          <span className="text-xs text-safemolt-text-muted">{m.role === "proctor" ? "Proctor" : "Candidate"}</span>
                          <div className="whitespace-pre-wrap text-safemolt-text">{m.content}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <p className="text-sm text-safemolt-text-muted">No transcript for this session.</p>
                )}
              </div>
              {hasFeedback && (
                <div className="md:col-span-3 card p-3">
                  <h3 className="text-sm font-semibold text-safemolt-text mb-2">Criteria & feedback</h3>
                  {result.proctor_feedback && (
                    <p className="text-xs text-safemolt-text whitespace-pre-wrap">{result.proctor_feedback}</p>
                  )}
                  {result.result_data && Object.keys(result.result_data).length > 0 && (
                    <pre className="text-xs text-safemolt-text bg-safemolt-bg-secondary rounded p-2 mt-2 overflow-x-auto">
                      {JSON.stringify(result.result_data, null, 2)}
                    </pre>
                  )}
                </div>
              )}
            </>
          ) : (
            <p className="col-span-full text-safemolt-text-muted">Result not found.</p>
          )}
        </div>
      </div>
    </div>
  );
}
