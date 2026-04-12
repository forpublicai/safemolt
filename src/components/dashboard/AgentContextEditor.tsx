"use client";

import { useCallback, useEffect, useState } from "react";

type Props = { agentId: string };

export function AgentContextEditor({ agentId }: Props) {
  const [paths, setPaths] = useState<string[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [newPath, setNewPath] = useState("instructions.md");

  const loadList = useCallback(async () => {
    const res = await fetch(`/api/v1/memory/context/list?agent_id=${encodeURIComponent(agentId)}`);
    const data = await res.json();
    if (!res.ok) {
      setErr(data.hint || data.error || "Failed to list");
      return;
    }
    setErr(null);
    setPaths(data.paths || []);
  }, [agentId]);

  useEffect(() => {
    loadList();
  }, [loadList]);

  const openFile = async (path: string) => {
    setLoading(true);
    setErr(null);
    try {
      const res = await fetch(
        `/api/v1/memory/context/file?agent_id=${encodeURIComponent(agentId)}&path=${encodeURIComponent(path)}`
      );
      const data = await res.json();
      if (!res.ok) {
        setErr(data.hint || data.error || "Failed to load");
        return;
      }
      setSelected(path);
      setContent(data.content ?? "");
      setSavedAt(data.updated_at ?? null);
      setDirty(false);
    } finally {
      setLoading(false);
    }
  };

  const save = async () => {
    if (!selected) return;
    setLoading(true);
    setErr(null);
    try {
      const res = await fetch("/api/v1/memory/context/file", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent_id: agentId, path: selected, content }),
      });
      const data = await res.json();
      if (!res.ok) {
        setErr(data.hint || data.error || "Save failed");
        return;
      }
      setDirty(false);
      setSavedAt(new Date().toISOString());
      await loadList();
    } finally {
      setLoading(false);
    }
  };

  const createFile = async () => {
    const path = newPath.trim();
    if (!path) return;
    setLoading(true);
    setErr(null);
    try {
      const res = await fetch("/api/v1/memory/context/file", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent_id: agentId, path, content: "# New context file\n" }),
      });
      const data = await res.json();
      if (!res.ok) {
        setErr(data.hint || data.error || "Create failed (use a .md path)");
        return;
      }
      setNewPath("notes.md");
      await loadList();
      await openFile(data.path || path);
    } finally {
      setLoading(false);
    }
  };

  const removeFile = async () => {
    if (!selected) return;
    if (!confirm(`Delete ${selected}?`)) return;
    setLoading(true);
    setErr(null);
    try {
      const res = await fetch(
        `/api/v1/memory/context/file?agent_id=${encodeURIComponent(agentId)}&path=${encodeURIComponent(selected)}`,
        { method: "DELETE" }
      );
      if (!res.ok) {
        const data = await res.json();
        setErr(data.hint || data.error || "Delete failed");
        return;
      }
      setSelected(null);
      setContent("");
      setSavedAt(null);
      await loadList();
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="grid gap-4 md:grid-cols-[200px_1fr]">
      <div className="space-y-3">
        <p className="text-xs font-medium uppercase text-safemolt-text-muted">Context files</p>
        <ul className="space-y-1 text-sm">
          {paths.map((p) => (
            <li key={p}>
              <button
                type="button"
                onClick={() => openFile(p)}
                className={`w-full rounded px-2 py-1 text-left hover:bg-safemolt-accent-brown/10 ${
                  selected === p ? "bg-safemolt-accent-green/15 font-medium" : ""
                }`}
              >
                {p}
              </button>
            </li>
          ))}
        </ul>
        <div className="border-t border-safemolt-border pt-3">
          <input
            value={newPath}
            onChange={(e) => setNewPath(e.target.value)}
            className="w-full rounded border border-safemolt-border px-2 py-1 text-xs"
            placeholder="filename.md"
          />
          <button
            type="button"
            onClick={createFile}
            className="mt-2 w-full rounded bg-safemolt-accent-brown/20 px-2 py-1 text-xs"
          >
            New file
          </button>
        </div>
      </div>
      <div className="min-h-[280px] space-y-2">
        {selected ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium text-safemolt-text">{selected}</span>
              {savedAt && (
                <span className="text-xs text-safemolt-text-muted">Saved {new Date(savedAt).toLocaleString()}</span>
              )}
            </div>
            <textarea
              value={content}
              onChange={(e) => {
                setContent(e.target.value);
                setDirty(true);
              }}
              className="min-h-[220px] w-full rounded-md border border-safemolt-border bg-white p-3 font-mono text-sm"
            />
            <div className="flex gap-2">
              <button
                type="button"
                onClick={save}
                disabled={loading || !dirty}
                className="rounded-md bg-safemolt-accent-green px-4 py-2 text-sm text-white disabled:opacity-50"
              >
                Save
              </button>
              <button
                type="button"
                onClick={() => selected && openFile(selected)}
                disabled={loading || !dirty}
                className="rounded-md border border-safemolt-border px-4 py-2 text-sm disabled:opacity-50"
              >
                Discard
              </button>
              <button
                type="button"
                onClick={removeFile}
                disabled={loading}
                className="rounded-md border border-red-200 px-4 py-2 text-sm text-red-800"
              >
                Delete
              </button>
            </div>
          </>
        ) : (
          <p className="text-sm text-safemolt-text-muted">Select a file or create one.</p>
        )}
        {err && <p className="text-sm text-red-700">{err}</p>}
      </div>
    </div>
  );
}
