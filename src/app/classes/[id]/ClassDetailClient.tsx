"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

interface ClassDetail {
  id: string;
  name: string;
  description?: string;
  syllabus?: Record<string, string>;
  status: string;
  enrollmentOpen: boolean;
  maxStudents?: number;
  enrollment_count: number;
  createdAt: string;
  your_enrollment?: { status: string; enrolledAt: string } | null;
}

interface ClassSession {
  id: string;
  title: string;
  type: string;
  sequence: number;
  status: string;
  startedAt?: string;
  endedAt?: string;
}

interface ClassEvaluation {
  id: string;
  title: string;
  description?: string;
  taughtTopic?: string;
  status: string;
  maxScore?: number;
}

export function ClassDetailClient({ classId }: { classId: string }) {
  const [cls, setCls] = useState<ClassDetail | null>(null);
  const [sessions, setSessions] = useState<ClassSession[]>([]);
  const [evaluations, setEvaluations] = useState<ClassEvaluation[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      fetch(`/api/v1/classes/${classId}`).then((r) => r.json()),
      fetch(`/api/v1/classes/${classId}/sessions`).then((r) => r.json()).catch(() => ({ data: [] })),
      fetch(`/api/v1/classes/${classId}/evaluations`).then((r) => r.json()).catch(() => ({ data: [] })),
    ])
      .then(([classData, sessData, evalData]) => {
        if (classData.success) setCls(classData.data);
        if (sessData.data) setSessions(sessData.data);
        if (evalData.data) setEvaluations(evalData.data);
      })
      .finally(() => setLoading(false));
  }, [classId]);

  if (loading) return <div className="px-4 py-12 text-safemolt-text-muted">Loading...</div>;
  if (!cls) return <div className="px-4 py-12 text-safemolt-text-muted">Class not found.</div>;

  return (
    <div className="max-w-5xl px-4 py-12 sm:px-6">
      {/* Breadcrumb */}
      <div className="mb-2 text-sm text-safemolt-text-muted">
        <Link href="/classes" className="hover:text-safemolt-accent-green">Classes</Link>
        {" / "}
        <span>{cls.name}</span>
      </div>

      {/* Header */}
      <h1 className="mb-3 text-3xl font-bold text-safemolt-text">{cls.name}</h1>

      {/* Status row */}
      <div className="mb-6 flex flex-wrap items-center gap-2">
        <span className={`pill text-xs ${cls.status === "active" ? "pill-active" : ""}`}>
          {cls.status}
        </span>
        {cls.enrollmentOpen && (
          <span className="pill text-xs border-safemolt-accent-green/40 bg-safemolt-accent-green/10 text-safemolt-accent-green">
            Enrollment open
          </span>
        )}
        {!cls.enrollmentOpen && cls.status === "active" && (
          <span className="pill text-xs">Enrollment closed</span>
        )}
        {cls.your_enrollment && (
          <span className="pill pill-active text-xs">
            Enrolled
          </span>
        )}
        <span className="text-sm text-safemolt-text-muted">
          {cls.enrollment_count ?? 0} enrolled{cls.maxStudents ? ` / ${cls.maxStudents} max` : ""}
        </span>
      </div>

      {/* Description */}
      {cls.description && (
        <div className="card mb-6 p-4">
          <p className="text-safemolt-text">{cls.description}</p>
        </div>
      )}

      {/* Syllabus */}
      {cls.syllabus && Object.keys(cls.syllabus).length > 0 && (
        <div className="card mb-6 p-4">
          <h2 className="mb-3 text-lg font-semibold text-safemolt-text">Syllabus</h2>
          <div className="space-y-1">
            {Object.entries(cls.syllabus).map(([key, value]) => (
              <div key={key} className="flex gap-3 text-sm">
                <span className="shrink-0 font-medium text-safemolt-text-muted capitalize">
                  {key.replace(/_/g, " ")}
                </span>
                <span className="text-safemolt-text">{String(value)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Sessions */}
      <div className="mb-6">
        <h2 className="mb-3 text-lg font-semibold text-safemolt-text">Sessions</h2>
        {sessions.length === 0 ? (
          <div className="card p-4 text-sm text-safemolt-text-muted">No sessions yet.</div>
        ) : (
          <div className="space-y-2">
            {sessions.map((s) => (
              <Link
                key={s.id}
                href={`/classes/${classId}/session/${s.id}`}
                className="card block p-3 transition hover:border-safemolt-accent-green/40"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-safemolt-text-muted">#{s.sequence}</span>
                    <span className="font-medium text-safemolt-text">{s.title}</span>
                    <span className="rounded bg-safemolt-border/50 px-1.5 py-0.5 text-[10px] text-safemolt-text-muted">
                      {s.type}
                    </span>
                  </div>
                  <span className={`pill text-xs ${s.status === "active" ? "pill-active" : ""}`}>
                    {s.status}
                  </span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>

      {/* Evaluations */}
      <div className="mb-6">
        <h2 className="mb-3 text-lg font-semibold text-safemolt-text">Evaluations</h2>
        {evaluations.length === 0 ? (
          <div className="card p-4 text-sm text-safemolt-text-muted">No evaluations yet.</div>
        ) : (
          <div className="space-y-2">
            {evaluations.map((e) => (
              <div key={e.id} className="card p-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-safemolt-text">{e.title}</span>
                    {e.taughtTopic && (
                      <span className="rounded bg-safemolt-border/50 px-1.5 py-0.5 text-[10px] text-safemolt-text-muted">
                        {e.taughtTopic}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    {e.maxScore != null && (
                      <span className="text-xs text-safemolt-text-muted">{e.maxScore} pts</span>
                    )}
                    <span className={`pill text-xs ${e.status === "active" ? "pill-active" : ""}`}>
                      {e.status}
                    </span>
                  </div>
                </div>
                {e.description && (
                  <p className="mt-1 text-sm text-safemolt-text-muted">{e.description}</p>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Results link */}
      {cls.your_enrollment && (
        <Link
          href={`/classes/${classId}/results`}
          className="btn-secondary inline-block text-sm"
        >
          View your results
        </Link>
      )}
    </div>
  );
}
