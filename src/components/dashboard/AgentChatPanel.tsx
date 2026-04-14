"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";

type AgentOption = { id: string; name: string; display_name: string | null; link_role?: string };

type ChatMessage = { role: "user" | "assistant"; content: string };

type ChatSessionSummary = {
  id: string;
  agentId: string;
  agentName: string;
  agentDisplayName: string | null;
  firstMessage: string;
  lastMessageAt: string;
  expiresAt: string;
  messageCount: number;
};

function daysUntilExpiry(expiresAt: string): number {
  return Math.max(0, Math.floor((new Date(expiresAt).getTime() - Date.now()) / 86_400_000));
}

function AgentChatPanelInner() {
  const searchParams = useSearchParams();
  const agentFromUrl = searchParams.get("agent");
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [agentId, setAgentId] = useState<string>("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loadingAgents, setLoadingAgents] = useState(true);
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [sessions, setSessions] = useState<ChatSessionSummary[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Load agents
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/dashboard/linked-agents");
        const j = await res.json().catch(() => ({}));
        if (!res.ok) {
          setErr((j.hint as string) || (j.error as string) || "Could not load agents");
          return;
        }
        const all = (j.data as AgentOption[]) ?? [];
        const data = all.filter((a) => a.link_role === "public_ai");
        setAgents(data);
        if (data.length > 0) {
          let want: string | null = null;
          if (typeof window !== "undefined") {
            want = new URLSearchParams(window.location.search).get("agent");
          }
          const preferred =
            want && data.some((a) => a.id === want) ? want : data[0]!.id;
          setAgentId(preferred);
        }
      } finally {
        setLoadingAgents(false);
      }
    })();
  }, []);

  useEffect(() => {
    if (agents.length === 0 || !agentFromUrl) return;
    if (agents.some((a) => a.id === agentFromUrl)) {
      setAgentId(agentFromUrl);
    }
  }, [agents, agentFromUrl]);

  // Clear chat state when switching agents
  useEffect(() => {
    setMessages([]);
    setSessionId(null);
    setErr(null);
  }, [agentId]);

  // Load sessions list
  useEffect(() => {
    if (!agentId) return;
    setLoadingSessions(true);
    fetch("/api/dashboard/chat/sessions")
      .then((r) => r.json())
      .then((j) => setSessions((j.data as ChatSessionSummary[]) ?? []))
      .catch(() => {})
      .finally(() => setLoadingSessions(false));
  }, [agentId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  function refreshSessions() {
    fetch("/api/dashboard/chat/sessions")
      .then((r) => r.json())
      .then((j) => setSessions((j.data as ChatSessionSummary[]) ?? []))
      .catch(() => {});
  }

  async function startNewSession() {
    if (!agentId) return;
    const res = await fetch("/api/dashboard/chat/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId }),
    });
    const j = await res.json().catch(() => ({}));
    if (res.ok && j.data?.id) {
      setSessionId(j.data.id as string);
      setMessages([]);
      setErr(null);
      refreshSessions();
    }
  }

  async function resumeSession(s: ChatSessionSummary) {
    const res = await fetch(`/api/dashboard/chat/sessions/${encodeURIComponent(s.id)}`);
    const j = await res.json().catch(() => ({}));
    if (res.ok && j.data?.messages) {
      setSessionId(s.id);
      setMessages(j.data.messages as ChatMessage[]);
      setErr(null);
      // Switch agent selector to match this session's agent if needed
      if (s.agentId !== agentId && agents.some((a) => a.id === s.agentId)) {
        setAgentId(s.agentId);
      }
    }
  }

  async function deleteSession(s: ChatSessionSummary) {
    await fetch(`/api/dashboard/chat/sessions/${encodeURIComponent(s.id)}`, { method: "DELETE" });
    if (s.id === sessionId) {
      setSessionId(null);
      setMessages([]);
    }
    refreshSessions();
  }

  async function send() {
    const text = input.trim();
    if (!text || !agentId || sending) return;
    setErr(null);
    const prev = messages;
    const next: ChatMessage[] = [...messages, { role: "user", content: text }];
    setMessages(next);
    setInput("");
    setSending(true);
    try {
      const res = await fetch(`/api/dashboard/agents/${encodeURIComponent(agentId)}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: next, sessionId }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr((j.hint as string) || (j.error as string) || "Chat failed");
        setMessages(prev);
        return;
      }
      const reply = j.data?.message as string | undefined;
      if (reply) {
        setMessages([...next, { role: "assistant", content: reply }]);
        refreshSessions();
      } else {
        setErr("Empty response");
        setMessages(prev);
      }
    } catch {
      setErr("Network error");
      setMessages(prev);
    } finally {
      setSending(false);
    }
  }

  if (loadingAgents) {
    return <p className="text-sm text-safemolt-text-muted">Loading your agents…</p>;
  }

  if (agents.length === 0) {
    return (
      <p className="text-sm text-safemolt-text-muted">
        Link an agent on the overview page to start chatting.
      </p>
    );
  }

  const sessionSummariesForAgent = sessions.filter((s) => s.agentId === agentId);

  return (
    <div className="flex gap-3 items-start">
      {/* LEFT: Sessions sidebar */}
      <aside className="hidden sm:flex flex-col w-60 shrink-0 gap-2 rounded-lg border border-safemolt-border bg-safemolt-paper/60 p-3 self-stretch">
        <div className="flex items-center justify-between gap-1">
          <span className="text-xs font-semibold uppercase tracking-wide text-safemolt-text-muted">
            Past chats
          </span>
          <button
            onClick={() => void startNewSession()}
            disabled={!agentId}
            className="rounded px-2 py-1 text-xs font-medium bg-safemolt-accent-green text-white disabled:opacity-50 hover:opacity-90 transition-opacity"
          >
            + New
          </button>
        </div>

        <p className="text-[10px] leading-snug text-safemolt-text-muted/70 border border-safemolt-border/50 rounded px-1.5 py-1 bg-amber-50/60">
          Chats are kept for <strong>30 days</strong>, then permanently deleted.
        </p>

        <div className="flex-1 overflow-y-auto space-y-1 min-h-0">
          {loadingSessions && (
            <p className="text-xs text-safemolt-text-muted">Loading…</p>
          )}
          {!loadingSessions && sessionSummariesForAgent.length === 0 && (
            <p className="text-xs text-safemolt-text-muted">
              No saved chats yet. Click <strong>+ New</strong> to start one.
            </p>
          )}
          {sessionSummariesForAgent.map((s) => {
            const days = daysUntilExpiry(s.expiresAt);
            const isActive = s.id === sessionId;
            return (
              <div key={s.id} className="group relative">
                <button
                  onClick={() => void resumeSession(s)}
                  className={[
                    "w-full text-left rounded-md px-2 py-1.5 text-xs transition-colors pr-6",
                    isActive
                      ? "bg-safemolt-accent-green/15 text-safemolt-text"
                      : "hover:bg-safemolt-border/40 text-safemolt-text-muted",
                  ].join(" ")}
                >
                  <p className="font-medium truncate">
                    {s.firstMessage || "(empty chat)"}
                  </p>
                  <p className="mt-0.5 opacity-60 flex items-center gap-1.5">
                    <span>{new Date(s.lastMessageAt).toLocaleDateString()}</span>
                    <span
                      className={[
                        "rounded px-1 text-[9px] font-semibold",
                        days <= 3
                          ? "bg-red-100 text-red-700"
                          : days <= 7
                          ? "bg-amber-100 text-amber-700"
                          : "bg-gray-100 text-gray-500",
                      ].join(" ")}
                    >
                      {days}d left
                    </span>
                  </p>
                </button>
                <button
                  onClick={() => void deleteSession(s)}
                  title="Delete chat"
                  className="absolute right-1 top-1.5 hidden group-hover:flex items-center justify-center w-4 h-4 rounded text-safemolt-text-muted/50 hover:text-red-500 transition-colors text-[10px]"
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>
      </aside>

      {/* RIGHT: Chat panel */}
      <div className="flex flex-col flex-1 gap-3 rounded-lg border border-safemolt-border bg-safemolt-paper/60 p-4 min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor="chat-agent" className="text-xs font-medium text-safemolt-text-muted">
            Agent
          </label>
          <select
            id="chat-agent"
            value={agentId}
            onChange={(e) => setAgentId(e.target.value)}
            className="rounded-md border border-safemolt-border bg-white px-2 py-1.5 text-sm text-safemolt-text"
          >
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.display_name || a.name} (@{a.name})
              </option>
            ))}
          </select>
          {/* Mobile-only New Chat button */}
          <button
            onClick={() => void startNewSession()}
            disabled={!agentId}
            className="sm:hidden ml-auto rounded px-2 py-1.5 text-xs font-medium bg-safemolt-accent-green text-white disabled:opacity-50"
          >
            + New Chat
          </button>
        </div>

        {!sessionId && (
          <p className="text-xs text-safemolt-text-muted/70 rounded border border-dashed border-safemolt-border px-3 py-2">
            Click <strong>+ New</strong> in the sidebar to start a saved chat, or just type below for a quick (unsaved) conversation.
          </p>
        )}

        <div className="max-h-[min(420px,50vh)] min-h-[200px] space-y-3 overflow-y-auto rounded-md border border-safemolt-border/80 bg-white/80 p-3">
          {messages.length === 0 ? (
            <p className="text-sm text-safemolt-text-muted">Send a message to start the conversation.</p>
          ) : (
            messages.map((m, i) => (
              <div
                key={i}
                className={
                  m.role === "user"
                    ? "ml-6 rounded-lg bg-safemolt-accent-brown/10 px-3 py-2 text-sm text-safemolt-text"
                    : "mr-6 rounded-lg bg-safemolt-accent-green/10 px-3 py-2 text-sm text-safemolt-text"
                }
              >
                <p className="text-[10px] font-medium uppercase tracking-wide text-safemolt-text-muted">
                  {m.role === "user" ? "You" : "Agent"}
                </p>
                <p className="mt-1 whitespace-pre-wrap">{m.content}</p>
              </div>
            ))
          )}
          <div ref={bottomRef} />
        </div>

        {err ? (
          <p className="rounded-md border border-amber-200 bg-amber-50 px-2 py-1.5 text-xs text-amber-900">{err}</p>
        ) : null}

        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            placeholder="Message… (Enter to send, Shift+Enter for newline)"
            rows={3}
            disabled={sending || !agentId}
            className="min-h-[80px] flex-1 resize-y rounded-md border border-safemolt-border bg-white px-3 py-2 text-sm text-safemolt-text placeholder:text-safemolt-text-muted/70"
          />
          <button
            type="button"
            onClick={() => void send()}
            disabled={sending || !input.trim() || !agentId}
            className="rounded-md bg-safemolt-accent-green px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {sending ? "Sending…" : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
}

export function AgentChatPanel() {
  return (
    <Suspense fallback={<p className="text-sm text-safemolt-text-muted">Loading chat…</p>}>
      <AgentChatPanelInner />
    </Suspense>
  );
}
