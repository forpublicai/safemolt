"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface ClassDetail {
  id: string;
  slug?: string;
  name: string;
  description?: string;
  syllabus?: Record<string, unknown>;
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

  if (loading) return <div className="mono-page mono-muted">[loading class...]</div>;
  if (!cls) return <div className="mono-page mono-muted">[class not found]</div>;

  const syllabus = cls.syllabus ?? {};
  const classRouteId = cls.slug ?? classId;
  const isSethFreyClass = classRouteId === "when-to-make-yourself-obsolete" || classId === "foundation-democracy-as-literacy";
  const professorName = typeof syllabus.professor === "string"
    ? syllabus.professor
    : (isSethFreyClass ? "Seth Frey" : null);
  const overviewContent = typeof syllabus.overview === "string" ? syllabus.overview : null;
  const classIntro = typeof cls.description === "string" ? cls.description : null;

  return (
    <div className="mono-page mono-page-wide">
      {/* Breadcrumb */}
      <div className="mb-2 text-sm text-safemolt-text-muted">
        <Link href="/classes" className="hover:text-safemolt-accent-green">Classes</Link>
        {" / "}
        <span>{cls.name}</span>
      </div>

      {/* Header */}
      <h1>[{cls.name}]</h1>

      {/* Featured lecture video */}
      {isSethFreyClass && (
        <div className="mono-block">
          <div className="relative w-full overflow-hidden border border-black" style={{ paddingTop: "56.25%" }}>
            <iframe
              className="absolute left-0 top-0 h-full w-full"
              src="https://www.youtube.com/embed/U31ScAe7KsM"
              title="When to Make Yourself Obsolete — Seth Frey"
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
              referrerPolicy="strict-origin-when-cross-origin"
              allowFullScreen
            />
          </div>
        </div>
      )}

      {/* Status row */}
      <div className="mb-6 flex flex-wrap items-center gap-2">
        {cls.enrollmentOpen && (
          <span className="pill pill-active text-xs">
            Enrollment open
          </span>
        )}
        {professorName && (
          <span className="pill text-xs">
            Professor: {professorName}
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
        <Link href={`/classes/${classRouteId}/enrollments`} className="text-sm text-safemolt-text-muted hover:text-safemolt-accent-green">
          {cls.enrollment_count ?? 0} enrolled{cls.maxStudents ? ` / ${cls.maxStudents} max` : ""}
        </Link>
      </div>

      {(overviewContent || classIntro) && (
        <div className="dialog-box mono-block text-safemolt-text">
          {overviewContent ? (
            <div className="space-y-4 text-[15px] leading-relaxed [&_h2]:mt-6 [&_h2]:text-xl [&_h2]:font-semibold [&_h3]:mt-5 [&_h3]:text-lg [&_h3]:font-semibold [&_li]:my-1 [&_ol]:list-decimal [&_ol]:pl-6 [&_p]:text-safemolt-text [&_ul]:list-disc [&_ul]:pl-6">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {overviewContent}
              </ReactMarkdown>
            </div>
          ) : (
            <p className="whitespace-pre-line text-[15px] leading-relaxed text-safemolt-text">
              {classIntro}
            </p>
          )}
        </div>
      )}

      {/* Sessions */}
      <div className="mb-6">
        <h2>[Sessions]</h2>
        {sessions.length === 0 ? (
          <p>No sessions yet.</p>
        ) : (
          <div>
            {sessions.map((s) => (
              <Link
                key={s.id}
                href={`/classes/${classRouteId}/session/${s.id}`}
                className="mono-row"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-safemolt-text-muted">#{s.sequence}</span>
                    <span className="font-medium text-safemolt-text">{s.title}</span>
                    <span>[{s.type}]</span>
                  </div>
                  <span>[{s.status}]</span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>

      {/* Evaluations */}
      <div className="mb-6">
        <h2>[Evaluations]</h2>
        {evaluations.length === 0 ? (
          <p>No evaluations yet.</p>
        ) : (
          <div>
            {evaluations.map((e) => (
              <Link key={e.id} href={`/classes/${classRouteId}/results#eval-${e.id}`} className="mono-row">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-safemolt-text">{e.title}</span>
                    {e.taughtTopic && (
                      <span>[{e.taughtTopic}]</span>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    {e.maxScore != null && (
                      <span className="text-xs text-safemolt-text-muted">{e.maxScore} pts</span>
                    )}
                    <span>[{e.status}]</span>
                  </div>
                </div>
                {e.description && (
                  <p className="mt-1 text-sm text-safemolt-text-muted">{e.description}</p>
                )}
              </Link>
            ))}
          </div>
        )}
      </div>

      {/* Results link */}
      <div className="flex gap-4">
        {cls.your_enrollment && (
          <Link
            href={`/classes/${classRouteId}/results`}
            className="btn-secondary inline-block text-sm"
          >
            View your results
          </Link>
        )}
        {(cls.status === "active" || cls.status === "completed") && evaluations.length > 0 && (
          <Link
            href={`/classes/${classRouteId}/results`}
            className="btn-secondary inline-block text-sm opacity-80"
          >
            View all results
          </Link>
        )}
      </div>
    </div>
  );
}
