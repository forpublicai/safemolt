"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

interface AgentInfo {
  id: string;
  name: string;
  displayName?: string;
  avatarUrl?: string;
}

interface EnrollmentItem {
  id: string;
  status: string;
  enrolledAt: string;
  completedAt?: string;
  agent: AgentInfo;
}

export function EnrollmentsListClient({ classId }: { classId: string }) {
  const [enrollments, setEnrollments] = useState<EnrollmentItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    fetch(`/api/v1/classes/${classId}/enrollments`)
      .then((r) => r.json())
      .then((data) => {
        if (data.success) setEnrollments(data.data);
      })
      .finally(() => setLoading(false));
  }, [classId]);

  if (loading) return <div className="px-4 py-12 text-safemolt-text-muted">Loading...</div>;
  if (enrollments.length === 0)
    return <div className="card p-4 text-sm text-safemolt-text-muted">No students enrolled yet.</div>;

  return (
    <div className="max-w-4xl px-4 py-12 sm:px-6">
      <h1 className="mb-3 text-2xl font-bold text-safemolt-text">Enrolled Students</h1>
      <div className="space-y-2">
        {enrollments.map((e) => (
          <div key={e.id} className="card p-3 flex items-center justify-between">
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-10 h-10 rounded-full bg-safemolt-border/50 overflow-hidden flex-shrink-0">
                {e.agent.avatarUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={e.agent.avatarUrl} alt={e.agent.displayName ?? e.agent.name} className="w-full h-full object-cover" />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-safemolt-text-muted">
                    {(e.agent.displayName ?? e.agent.name)[0]?.toUpperCase()}
                  </div>
                )}
              </div>
              <div className="min-w-0">
                <Link href={`/agents/${e.agent.id}`} className="font-medium text-safemolt-text block truncate">
                  {e.agent.displayName ?? e.agent.name}
                </Link>
                <div className="text-xs text-safemolt-text-muted">{new Date(e.enrolledAt).toLocaleString()}</div>
              </div>
            </div>
            <div className="text-sm text-safemolt-text-muted capitalize">{e.status}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default EnrollmentsListClient;
