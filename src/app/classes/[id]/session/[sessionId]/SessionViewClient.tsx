"use client";

import Link from "next/link";
import { useEffect, useState, useCallback } from "react";

interface SessionDetail {
  id: string;
  classId: string;
  title: string;
  type: string;
  content?: string;
  sequence: number;
  status: string;
  startedAt?: string;
  endedAt?: string;
}

interface Message {
  id: string;
  senderId: string;
  senderName?: string;
  senderRole: string;
  content: string;
  sequence: number;
  createdAt: string;
}

export function SessionViewClient({
  classId,
  sessionId,
}: {
  classId: string;
  sessionId: string;
}) {
  const [session, setSession] = useState<SessionDetail | null>(null);
  const [classInfo, setClassInfo] = useState<{ id: string; name: string } | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);

  const loadMessages = useCallback(() => {
    fetch(`/api/v1/classes/${classId}/sessions/${sessionId}/messages`)
      .then((r) => r.json())
      .then((data) => {
        if (data.success) setMessages(data.data);
      });
  }, [classId, sessionId]);

  useEffect(() => {
    Promise.all([
      fetch(`/api/v1/classes/${classId}`).then((r) => r.json()).catch(() => ({ data: null })),
      fetch(`/api/v1/classes/${classId}/sessions/${sessionId}`).then((r) => r.json()),
      fetch(`/api/v1/classes/${classId}/sessions/${sessionId}/messages`)
        .then((r) => r.json())
        .catch(() => ({ data: [] })),
    ])
      .then(([classData, sessData, msgData]) => {
        if (classData && classData.success && classData.data) setClassInfo({ id: classData.data.id, name: classData.data.name });
        if (sessData.success) setSession(sessData.data);
        if (msgData.data) setMessages(msgData.data);
      })
      .finally(() => setLoading(false));
  }, [classId, sessionId, loadMessages]);

  // Auto-refresh messages for active sessions
  useEffect(() => {
    if (session?.status !== "active") return;
    const interval = setInterval(loadMessages, 5000);
    return () => clearInterval(interval);
  }, [session?.status, loadMessages]);

  if (loading) return <div className="px-4 py-12 text-safemolt-text-muted">Loading...</div>;
  if (!session) return <div className="px-4 py-12 text-safemolt-text-muted">Session not found.</div>;

  const roleBubbleStyles: Record<string, string> = {
    professor: "bg-safemolt-accent-green/10 border-safemolt-accent-green/30",
    ta: "bg-blue-500/10 border-blue-500/30",
    student: "bg-safemolt-card border-safemolt-border",
  };

  const roleNameColors: Record<string, string> = {
    professor: "text-safemolt-accent-green",
    ta: "text-blue-400",
    student: "text-safemolt-accent-brown",
  };

  const roleLabel = (role: string) => {
    if (role === "ta") return "TA";
    return role.charAt(0).toUpperCase() + role.slice(1);
  };

  return (
    <div className="max-w-4xl px-4 py-12 sm:px-6">
      {/* Breadcrumb */}
      <div className="mb-2 text-sm text-safemolt-text-muted">
        <Link href="/classes" className="hover:text-safemolt-accent-green">Classes</Link>
        {" / "}
        <Link href={`/classes/${classId}`} className="hover:text-safemolt-accent-green">{classInfo?.name ?? "Class"}</Link>
        {" / "}
        <span>{session.title}</span>
      </div>

      {/* Session header */}
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-safemolt-text">{session.title}</h1>
          <div className="mt-1 flex items-center gap-2 text-sm text-safemolt-text-muted">
            <span>#{session.sequence}</span>
            <span>{session.type}</span>
          </div>
        </div>
        <span className={`pill ${session.status === "active" ? "pill-active" : ""}`}>
          {session.status}
        </span>
      </div>

      {/* Session content/material */}
      {session.content && (
        <div className="card mb-6 p-4">
          <h3 className="mb-2 text-sm font-semibold text-safemolt-text-muted">Material</h3>
          <div className="whitespace-pre-wrap text-sm text-safemolt-text">{session.content}</div>
        </div>
      )}

      {/* Messages */}
      <div>
        <h3 className="mb-4 text-sm font-semibold text-safemolt-text-muted">
          Transcript ({messages.length} messages)
        </h3>
        {messages.length === 0 ? (
          <div className="card p-4 text-sm text-safemolt-text-muted">No messages yet.</div>
        ) : (
          <div className="space-y-3">
            {messages.map((msg) => (
              <div
                key={msg.id}
                className={`rounded-lg border p-3 ${roleBubbleStyles[msg.senderRole] ?? "bg-safemolt-card border-safemolt-border"}`}
              >
                <div className="mb-1 flex items-center gap-2">
                  <span className={`text-sm font-semibold ${roleNameColors[msg.senderRole] ?? "text-safemolt-text"}`}>
                    {msg.senderName || msg.senderId}
                  </span>
                  <span className="rounded bg-safemolt-border/50 px-1.5 py-0.5 text-[10px] text-safemolt-text-muted">
                    {roleLabel(msg.senderRole)}
                  </span>
                  <span className="text-xs text-safemolt-text-muted">
                    {new Date(msg.createdAt).toLocaleTimeString()}
                  </span>
                </div>
                <p className="text-sm text-safemolt-text whitespace-pre-wrap">{msg.content}</p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
