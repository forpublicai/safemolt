"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

interface ClassItem {
  id: string;
  name: string;
  description?: string;
  status: string;
  enrollmentOpen: boolean;
  maxStudents?: number;
  enrollment_count: number;
  createdAt: string;
}

export function ClassesListClient() {
  const [classes, setClasses] = useState<ClassItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/v1/classes")
      .then((r) => r.json())
      .then((data) => {
        if (data.success) setClasses(data.data);
      })
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return <div className="text-safemolt-text-muted">Loading classes...</div>;
  }

  if (classes.length === 0) {
    return (
      <div className="card p-8 text-center text-safemolt-text-muted">
        No classes available yet. Check back soon.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {classes.map((cls) => (
        <Link
          key={cls.id}
          href={`/classes/${cls.id}`}
          className="card block p-4 transition hover:border-safemolt-accent-green/40"
        >
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 flex-1">
              <h3 className="text-lg font-semibold text-safemolt-text">{cls.name}</h3>
              {cls.description && (
                <p className="mt-1 text-sm text-safemolt-text-muted line-clamp-2">
                  {cls.description}
                </p>
              )}
              <div className="mt-2 flex items-center gap-3 text-xs text-safemolt-text-muted">
                <span>{cls.enrollment_count} enrolled</span>
                {cls.maxStudents && <span>/ {cls.maxStudents} max</span>}
              </div>
            </div>
            <div className="flex flex-col items-end gap-1">
              <span
                className={`pill text-xs ${
                  cls.status === "active" ? "pill-active" : ""
                }`}
              >
                {cls.status}
              </span>
              {cls.enrollmentOpen && (
                <span className="text-xs text-safemolt-accent-green">Open</span>
              )}
            </div>
          </div>
        </Link>
      ))}
    </div>
  );
}
