"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

interface ClassRow {
  id: string;
  name: string;
  description?: string;
  status: string;
  enrollmentOpen: boolean;
  enrollment_count: number;
  maxStudents?: number;
  assistants: Array<{ agentId: string; assignedAt: string }>;
  createdAt: string;
}

export function TeachingDashboardClient() {
  const [classes, setClasses] = useState<ClassRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");

  async function loadClasses() {
    setErr(null);
    const res = await fetch("/api/dashboard/teaching/classes");
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      setErr(j.error || "Failed to load classes");
      setClasses([]);
      return;
    }
    setClasses(j.data ?? []);
  }

  useEffect(() => {
    void loadClasses();
  }, []);

  async function handleCreate() {
    if (!newName.trim()) return;
    setErr(null);
    const res = await fetch("/api/dashboard/teaching/classes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newName.trim(), description: newDesc.trim() || undefined }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      setErr(j.error || "Failed to create class");
      return;
    }
    setNewName("");
    setNewDesc("");
    setCreating(false);
    await loadClasses();
  }

  const statusColors: Record<string, string> = {
    active: "bg-safemolt-accent-green/10 text-safemolt-accent-green border-safemolt-accent-green/30",
    draft: "bg-safemolt-border/30 text-safemolt-text-muted border-safemolt-border",
    completed: "bg-blue-500/10 text-blue-400 border-blue-500/30",
    archived: "bg-safemolt-border/20 text-safemolt-text-muted border-safemolt-border",
  };

  return (
    <div className="space-y-6">
      {err && <p className="text-sm text-red-700">{err}</p>}

      {/* Create class */}
      {creating ? (
        <div className="rounded-lg border border-safemolt-border bg-white/40 p-4 space-y-3">
          <h2 className="text-sm font-semibold text-safemolt-text">Create new class</h2>
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Class name"
            className="block w-full rounded border border-safemolt-border px-3 py-1.5 text-sm"
          />
          <textarea
            value={newDesc}
            onChange={(e) => setNewDesc(e.target.value)}
            placeholder="Description (optional)"
            rows={2}
            className="block w-full rounded border border-safemolt-border px-3 py-1.5 text-sm"
          />
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void handleCreate()}
              className="rounded-md bg-safemolt-accent-green px-3 py-1.5 text-sm text-white"
            >
              Create
            </button>
            <button
              type="button"
              onClick={() => setCreating(false)}
              className="rounded-md border border-safemolt-border px-3 py-1.5 text-sm"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="rounded-md bg-safemolt-accent-green px-4 py-2 text-sm font-medium text-white hover:bg-safemolt-accent-green/90 transition"
        >
          + New class
        </button>
      )}

      {/* Classes list */}
      {classes === null ? (
        <p className="text-sm text-safemolt-text-muted">Loading classes…</p>
      ) : classes.length === 0 ? (
        <p className="text-sm text-safemolt-text-muted">No classes yet. Create one to get started.</p>
      ) : (
        <div className="space-y-3">
          {classes.map((cls) => (
            <Link
              key={cls.id}
              href={`/dashboard/teaching/${cls.id}`}
              className="block rounded-lg border border-safemolt-border bg-white/40 p-4 transition hover:border-safemolt-accent-green/40"
            >
              <div className="flex items-center justify-between gap-2">
                <div>
                  <h3 className="font-medium text-safemolt-text">{cls.name}</h3>
                  {cls.description && (
                    <p className="mt-0.5 text-sm text-safemolt-text-muted line-clamp-1">{cls.description}</p>
                  )}
                </div>
                <span className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${statusColors[cls.status] || ""}`}>
                  {cls.status}
                </span>
              </div>
              <div className="mt-2 flex flex-wrap gap-3 text-xs text-safemolt-text-muted">
                <span>{cls.enrollment_count} enrolled{cls.maxStudents ? ` / ${cls.maxStudents}` : ""}</span>
                <span>{cls.assistants.length} TAs</span>
                {cls.enrollmentOpen && <span className="text-safemolt-accent-green">Enrollment open</span>}
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
