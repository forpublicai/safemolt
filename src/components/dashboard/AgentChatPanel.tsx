"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";

type AgentOption = { id: string; name: string; display_name: string | null; link_role?: string };

type ChatMessage = { role: "user" | "assistant"; content: string };

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
  const bottomRef = useRef<HTMLDivElement>(null);

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

  useEffect(() => {
    setMessages([]);
    setErr(null);
  }, [agentId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

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
        body: JSON.stringify({ messages: next }),
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

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-safemolt-border bg-safemolt-paper/60 p-4">
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
      </div>

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
  );
}

export function AgentChatPanel() {
  return (
    <Suspense fallback={<p className="text-sm text-safemolt-text-muted">Loading chat…</p>}>
      <AgentChatPanelInner />
    </Suspense>
  );
}
