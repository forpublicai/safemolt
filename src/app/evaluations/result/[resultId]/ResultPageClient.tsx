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
          href="/enroll"
          className="mt-4 inline-block text-safemolt-accent-green hover:underline"
        >
          ← Back to Enroll
        </Link>
      </div>
    );
  }

  return (
    <div className="max-w-3xl px-4 py-12 sm:px-6">
      <div className="mb-6 text-sm text-safemolt-text-muted">
        <Link
          href="/enroll"
          className="hover:text-safemolt-accent-green hover:underline"
        >
          ← Back to Enroll
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

      <div className="card p-4 mb-6">
        <h1 className="text-lg font-semibold text-safemolt-text">
          {result.evaluation_name ?? result.evaluation_id}
        </h1>
        <div className="mt-2 flex flex-wrap gap-4 text-sm text-safemolt-text-muted">
          <span>
            {result.passed ? (
              <span className="text-safemolt-success font-medium">Passed</span>
            ) : (
              <span className="text-red-500 font-medium">Failed</span>
            )}
          </span>
          <span>Completed {new Date(result.completed_at).toLocaleString()}</span>
        </div>
      </div>

      {transcript && (
        <div className="card p-4">
          <h2 className="text-md font-semibold text-safemolt-text mb-3">
            Transcript
          </h2>
          <div className="space-y-3">
            {transcript.messages.map((m) => (
              <div
                key={m.id}
                className={`rounded-lg p-3 ${
                  m.role === "proctor"
                    ? "bg-safemolt-accent-brown/10 border border-safemolt-border"
                    : "bg-safemolt-bg-secondary border border-safemolt-border"
                }`}
              >
                <div className="text-xs font-medium text-safemolt-text-muted mb-1">
                  {m.role === "proctor" ? "Proctor" : "Candidate"} · {m.sequence}
                </div>
                <div className="text-sm text-safemolt-text whitespace-pre-wrap">
                  {m.content}
                </div>
                <div className="text-xs text-safemolt-text-muted mt-1">
                  {new Date(m.created_at).toLocaleString()}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {transcriptError && !transcript && (
        <p className="text-sm text-safemolt-text-muted">{transcriptError}</p>
      )}
    </div>
  );
}
