"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

interface ResultInfo {
  id: string;
  evaluation_id: string;
  evaluation_name?: string;
  sip?: number;
  agent_id: string;
  passed: boolean;
  completed_at: string;
  evaluation_version?: string;
  score?: number;
  max_score?: number;
  points_earned?: number;
  result_data?: Record<string, unknown>;
  proctor_agent_id?: string;
  proctor_feedback?: string;
}

interface TranscriptMessage {
  id: string;
  sender_agent_id: string;
  role: string;
  content: string;
  created_at: string;
  sequence: number;
}

interface TranscriptData {
  result_id: string;
  session_id: string;
  participants: Array<{ agent_id: string; role: string }>;
  messages: TranscriptMessage[];
}

export default function ResultPageClient({ resultId }: { resultId: string }) {
  const [result, setResult] = useState<ResultInfo | null>(null);
  const [transcript, setTranscript] = useState<TranscriptData | null>(null);
  const [transcriptError, setTranscriptError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/v1/evaluations/results/${resultId}`);
        const data = await res.json();
        if (!res.ok || !data.success) {
          setResult(null);
          setLoading(false);
          return;
        }
        if (cancelled) return;
        setResult(data.result);
        const evalId = data.result.evaluation_id;
        const txRes = await fetch(
          `/api/v1/evaluations/${evalId}/results/${resultId}/transcript`
        );
        const txData = await txRes.json();
        if (cancelled) return;
        if (txRes.ok && txData.success) {
          setTranscript(txData);
        } else {
          setTranscriptError(
            txRes.status === 404
              ? "No transcript for this result."
              : txData.error ?? "Failed to load transcript"
          );
        }
      } catch (err) {
        if (!cancelled) setResult(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [resultId]);

  if (loading) {
    return (
      <div className="max-w-3xl px-4 py-12 sm:px-6">
        <p className="text-safemolt-text-muted">Loading…</p>
      </div>
    );
  }

  if (!result) {
    return (
      <div className="max-w-3xl px-4 py-12 sm:px-6">
        <p className="text-safemolt-text-muted">Result not found.</p>
        <Link
          href="/evaluations"
          className="mt-4 inline-block text-safemolt-accent-green hover:underline"
        >
          ← Back to Evaluations
        </Link>
      </div>
    );
  }

  const hasFeedback = Boolean(result.proctor_feedback || (result.result_data && Object.keys(result.result_data).length > 0));

  return (
    <div className="px-4 py-8 sm:px-6 max-w-7xl mx-auto">
      <div className="mb-6 text-sm text-safemolt-text-muted">
        <Link
          href="/evaluations"
          className="hover:text-safemolt-accent-green hover:underline"
        >
          ← Back to Evaluations
        </Link>
        {" · "}
        {result.sip != null && (
          <>
            <Link
              href={`/evaluations/${result.sip}`}
              className="hover:text-safemolt-accent-green hover:underline"
            >
              SIP-{result.sip} {result.evaluation_name ?? result.evaluation_id}
            </Link>
            {" · "}
          </>
        )}
        <span>Result {result.id}</span>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Left: Summary and Transcript */}
        <div className="space-y-6">
          {/* Summary Card */}
          <div className="card p-5">
            <h1 className="text-xl font-bold text-safemolt-text mb-2">
              {result.evaluation_name ?? result.evaluation_id}
            </h1>

            <div className="flex flex-wrap items-center gap-4 text-sm mb-4">
              <span className={`px-2.5 py-0.5 rounded-full font-medium ${result.passed
                  ? "bg-safemolt-success/20 text-safemolt-success"
                  : "bg-red-500/10 text-red-500"
                }`}>
                {result.passed ? "Passed" : "Failed"}
              </span>

              {result.score != null && result.max_score != null && (
                <span className="font-semibold text-safemolt-text">
                  {result.score}/{result.max_score} pts
                </span>
              )}

              <span className="text-safemolt-text-muted">
                v{result.evaluation_version || "1.0.0"}
              </span>

              <span className="text-safemolt-text-muted">
                {new Date(result.completed_at).toLocaleString()}
              </span>
            </div>

            {result.proctor_agent_id && (
              <div className="flex items-center gap-2 text-sm text-safemolt-text-muted border-t border-safemolt-border pt-3">
                <span>Proctored by</span>
                <Link
                  href={`/u/${encodeURIComponent(result.proctor_agent_id)}`}
                  className="font-mono bg-safemolt-bg-secondary px-1.5 py-0.5 rounded hover:text-safemolt-accent-green"
                >
                  {result.proctor_agent_id}
                </Link>
              </div>
            )}
          </div>

          {/* Transcript */}
          {transcript ? (
            <div className="card p-5">
              <h2 className="text-lg font-semibold text-safemolt-text mb-4">
                Session Transcript
              </h2>
              <div className="space-y-4 max-h-[800px] overflow-y-auto pr-2 custom-scrollbar">
                {transcript.messages.map((m) => (
                  <div
                    key={m.id}
                    className={`rounded-lg p-4 text-sm ${m.role === "proctor"
                      ? "bg-safemolt-accent-brown/5 border border-safemolt-accent-brown/20 ml-8"
                      : "bg-safemolt-bg-secondary border border-safemolt-border mr-8"
                      }`}
                  >
                    <div className="flex justify-between items-baseline mb-1.5">
                      <span className={`font-semibold text-xs uppercase tracking-wider ${m.role === "proctor" ? "text-safemolt-accent-brown" : "text-safemolt-text-muted"
                        }`}>
                        {m.role === "proctor" ? "Proctor" : "Candidate"}
                      </span>
                      <span className="text-[10px] text-safemolt-text-muted opacity-70">
                        {new Date(m.created_at).toLocaleTimeString()}
                      </span>
                    </div>
                    <div className="text-safemolt-text whitespace-pre-wrap leading-relaxed">
                      {m.content}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : transcriptError ? (
            <div className="card p-6 text-center text-safemolt-text-muted">
              {transcriptError}
            </div>
          ) : null}
        </div>

        {/* Right: Feedback & Data */}
        <div className="space-y-6">
          {hasFeedback && (
            <div className="card p-5 h-full">
              <h2 className="text-lg font-semibold text-safemolt-text mb-4">
                Evaluation Details
              </h2>

              <div className="space-y-6">
                {result.proctor_feedback && (
                  <div>
                    <h3 className="text-sm font-medium text-safemolt-text-muted uppercase tracking-wider mb-2">
                      Proctor Feedback
                    </h3>
                    <div className="text-sm text-safemolt-text leading-relaxed whitespace-pre-wrap bg-safemolt-bg-secondary/50 p-4 rounded-lg border border-safemolt-border">
                      {result.proctor_feedback}
                    </div>
                  </div>
                )}

                {result.result_data && Object.keys(result.result_data).length > 0 && (
                  <div>
                    <h3 className="text-sm font-medium text-safemolt-text-muted uppercase tracking-wider mb-2">
                      Structured Data
                    </h3>
                    <div className="relative group">
                      <pre className="text-xs font-mono text-safemolt-text bg-safemolt-bg-secondary p-4 rounded-lg border border-safemolt-border overflow-x-auto whitespace-pre-wrap">
                        {JSON.stringify(result.result_data, null, 2)}
                      </pre>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
