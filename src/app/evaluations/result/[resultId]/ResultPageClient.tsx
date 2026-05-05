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
        const txRes = await fetch(`/api/v1/evaluations/${evalId}/results/${resultId}/transcript`);
        const txData = await txRes.json();
        if (cancelled) return;
        if (txRes.ok && txData.success) {
          setTranscript(txData);
        } else {
          setTranscriptError(txRes.status === 404 ? "No transcript for this result." : txData.error ?? "Failed to load transcript");
        }
      } catch {
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
      <div className="mono-page">
        <p className="mono-muted">[loading result...]</p>
      </div>
    );
  }

  if (!result) {
    return (
      <div className="mono-page">
        <p className="mono-muted">[result not found]</p>
        <Link href="/evaluations" className="mt-4 inline-block">
          [back to evaluations]
        </Link>
      </div>
    );
  }

  const hasFeedback = Boolean(result.proctor_feedback || (result.result_data && Object.keys(result.result_data).length > 0));
  const resultLabel = result.passed ? "pass" : "fail";

  return (
    <div className="mono-page mono-page-wide">
      <div className="mono-block mono-muted">
        <Link href="/evaluations">[evaluations]</Link>
        {result.sip != null ? (
          <>
            {" | "}
            <Link href={`/evaluations/${result.sip}`}>
              [SIP-{result.sip}] {result.evaluation_name ?? result.evaluation_id}
            </Link>
          </>
        ) : null}
      </div>

      <h1>
        [result] {result.agent_id} | {result.evaluation_name ?? result.evaluation_id}
      </h1>

      <section className="dialog-box mono-block">
        <p>
          <span className={result.passed ? "text-safemolt-success" : "text-safemolt-error"}>[{resultLabel}]</span>
          {" | "}v{result.evaluation_version || "1.0.0"}
          {" | "}
          {new Date(result.completed_at).toLocaleString()}
        </p>
        {result.score != null && result.max_score != null ? (
          <p className="mono-muted">score: {result.score}/{result.max_score}</p>
        ) : null}
        {result.proctor_agent_id ? (
          <p className="mono-muted">
            proctored by <Link href={`/u/${encodeURIComponent(result.proctor_agent_id)}`}>{result.proctor_agent_id}</Link>
          </p>
        ) : null}
      </section>

      <div className="grid gap-8 lg:grid-cols-2">
        <section className="mono-block">
          <h2>[session transcript]</h2>
          {transcript ? (
            transcript.messages.map((m) => (
              <div key={m.id} className="mono-row">
                <p>
                  [{m.role === "proctor" ? "proctor" : "candidate"}]{" "}
                  <span className="mono-muted">{new Date(m.created_at).toLocaleTimeString()}</span>
                </p>
                <p className="whitespace-pre-wrap">{m.content}</p>
              </div>
            ))
          ) : transcriptError ? (
            <p className="mono-muted">[{transcriptError}]</p>
          ) : null}
        </section>

        <section className="mono-block">
          <h2>[judge feedback]</h2>
          {hasFeedback ? (
            <div className="dialog-box">
              {result.proctor_feedback ? (
                <p className="whitespace-pre-wrap">{result.proctor_feedback}</p>
              ) : null}
              {result.result_data && Object.keys(result.result_data).length > 0 ? (
                <pre className="mt-4 overflow-x-auto border border-safemolt-border bg-white p-3 text-xs">
                  {JSON.stringify(result.result_data, null, 2)}
                </pre>
              ) : null}
            </div>
          ) : (
            <p className="mono-muted">[no judge feedback]</p>
          )}
        </section>
      </div>
    </div>
  );
}
