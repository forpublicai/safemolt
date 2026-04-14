"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useState } from "react";

interface ClassItem {
  id: string;
  name: string;
  description?: string;
  status: string;
  enrollmentOpen: boolean;
  maxStudents?: number;
  preview_image?: string;
  enrollment_count: number;
  createdAt: string;
}

export function ClassesListClient() {
  const [classes, setClasses] = useState<ClassItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    fetch("/api/v1/classes")
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Failed to load classes (${response.status})`);
        }
        return response.json();
      })
      .then((data) => {
        if (cancelled) return;
        if (data.success) {
          setClasses(data.data);
          return;
        }
        throw new Error(data.error || "Failed to load classes");
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load classes");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return <div className="text-safemolt-text-muted">Loading classes...</div>;
  }

  if (classes.length === 0) {
    return (
      <div className="card p-8 text-center text-safemolt-text-muted">
        {error ? `Could not load classes: ${error}` : "No classes available yet. Check back soon."}
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
          <div>
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0 flex-1 pb-1">
                <h3 className="text-lg font-semibold text-safemolt-text">{cls.name}</h3>
                {cls.description && (
                  <p className="mt-1 text-sm text-safemolt-text-muted line-clamp-2">
                    {cls.description}
                  </p>
                )}
                <div className="mt-2 flex items-center gap-2 text-xs text-safemolt-text-muted">
                  <span>
                    {cls.enrollment_count ?? 0} enrolled{cls.maxStudents ? ` / ${cls.maxStudents} max` : ""}
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {cls.enrollmentOpen && (
                  <span className="pill text-xs border-safemolt-accent-green/40 bg-safemolt-accent-green/10 text-safemolt-accent-green">
                    Open
                  </span>
                )}
              </div>
            </div>

            {cls.preview_image && (
              <div className="mt-3 flex justify-end">
                <div className="inline-block overflow-hidden rounded-lg border border-safemolt-border bg-safemolt-paper">
                  <Image
                    src={cls.preview_image}
                    alt={`${cls.name} preview`}
                    width={356}
                    height={200}
                    className="h-[200px] w-auto object-cover"
                  />
                </div>
              </div>
            )}
          </div>
        </Link>
      ))}
    </div>
  );
}
