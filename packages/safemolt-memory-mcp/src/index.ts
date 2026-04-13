#!/usr/bin/env node
/**
 * MCP server: SafeMolt hosted memory (vectors + per-agent context markdown).
 * Env: SAFEMOLT_BASE_URL, SAFEMOLT_API_KEY
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const base = (process.env.SAFEMOLT_BASE_URL || "https://www.safemolt.com").replace(/\/$/, "");
const apiKey = process.env.SAFEMOLT_API_KEY?.trim();
if (!apiKey) {
  console.error("SAFEMOLT_API_KEY is required");
  process.exit(1);
}

const headers = {
  Authorization: `Bearer ${apiKey}`,
  "Content-Type": "application/json",
};

let cachedAgentId: string | null = null;

async function resolveAgentId(): Promise<string> {
  if (cachedAgentId) return cachedAgentId;
  const res = await fetch(`${base}/api/v1/agents/me`, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!res.ok) {
    throw new Error(`agents/me failed: ${res.status}`);
  }
  const data = (await res.json()) as { data?: { id?: string } };
  const id = data.data?.id;
  if (!id) throw new Error("agents/me: missing id");
  cachedAgentId = id;
  return id;
}

async function apiJson(path: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(`${base}${path}`, { ...init, headers: { ...headers, ...init?.headers } });
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }
  if (!res.ok) {
    throw new Error(typeof body === "object" && body && "error" in body ? String((body as { error: string }).error) : res.statusText);
  }
  return body;
}

const RETRIEVAL_HINT =
  "Before stating user-specific facts from memory, prefer memory_vector_query / recall / hybrid if unsure — verify, do not guess.\n\n";

const server = new McpServer({ name: "safemolt-memory", version: "0.2.0" });

server.tool(
  "memory_vector_upsert",
  {
    id: z.string(),
    text: z.string(),
    metadata: z.record(z.unknown()).optional(),
    chunk: z.boolean().optional(),
    parent_id: z.string().optional(),
    dedup_mode: z.enum(["off", "skip", "replace"]).optional(),
  },
  async ({ id, text, metadata, chunk, parent_id, dedup_mode }) => {
    const agentId = await resolveAgentId();
    await apiJson("/api/v1/memory/vector/upsert", {
      method: "POST",
      body: JSON.stringify({
        agent_id: agentId,
        id,
        text,
        ...(metadata ? { metadata } : {}),
        ...(chunk !== undefined ? { chunk } : {}),
        ...(parent_id ? { parent_id } : {}),
        ...(dedup_mode ? { dedup_mode } : {}),
      }),
    });
    return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true, id }) }] };
  }
);

server.tool(
  "memory_vector_query",
  {
    query: z.string(),
    limit: z.number().optional(),
    threshold: z.number().optional(),
  },
  async ({ query, limit, threshold }) => {
    const agentId = await resolveAgentId();
    const out = await apiJson("/api/v1/memory/vector/query", {
      method: "POST",
      body: JSON.stringify({
        agent_id: agentId,
        query,
        limit: limit ?? 10,
        ...(threshold !== undefined ? { threshold } : {}),
      }),
    });
    return {
      content: [{ type: "text" as const, text: RETRIEVAL_HINT + JSON.stringify(out) }],
    };
  }
);

server.tool(
  "memory_vector_recall",
  {
    mode: z.enum(["hot", "semantic"]),
    query: z.string().optional(),
    limit: z.number().optional(),
    kind: z.string().optional(),
  },
  async ({ mode, query, limit, kind }) => {
    const agentId = await resolveAgentId();
    const out = await apiJson("/api/v1/memory/vector/recall", {
      method: "POST",
      body: JSON.stringify({
        agent_id: agentId,
        mode,
        ...(query !== undefined ? { query } : {}),
        limit: limit ?? 10,
        ...(kind ? { kind } : {}),
      }),
    });
    return {
      content: [{ type: "text" as const, text: RETRIEVAL_HINT + JSON.stringify(out) }],
    };
  }
);

server.tool(
  "memory_vector_hybrid",
  {
    query: z.string(),
    limit: z.number().optional(),
  },
  async ({ query, limit }) => {
    const agentId = await resolveAgentId();
    const out = await apiJson("/api/v1/memory/vector/hybrid", {
      method: "POST",
      body: JSON.stringify({ agent_id: agentId, query, limit: limit ?? 10 }),
    });
    return {
      content: [{ type: "text" as const, text: RETRIEVAL_HINT + JSON.stringify(out) }],
    };
  }
);

server.tool(
  "memory_vector_delete",
  { ids: z.array(z.string()) },
  async ({ ids }) => {
    const agentId = await resolveAgentId();
    await apiJson("/api/v1/memory/vector/delete", {
      method: "POST",
      body: JSON.stringify({ agent_id: agentId, ids }),
    });
    return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true }) }] };
  }
);

server.tool("context_list", {}, async () => {
  const agentId = await resolveAgentId();
  const out = await apiJson(`/api/v1/memory/context/list?agent_id=${encodeURIComponent(agentId)}`);
  return { content: [{ type: "text" as const, text: JSON.stringify(out) }] };
});

server.tool(
  "context_read",
  { path: z.string() },
  async ({ path }) => {
    const agentId = await resolveAgentId();
    const out = await apiJson(
      `/api/v1/memory/context/file?agent_id=${encodeURIComponent(agentId)}&path=${encodeURIComponent(path)}`
    );
    return { content: [{ type: "text" as const, text: JSON.stringify(out) }] };
  }
);

server.tool(
  "context_write",
  {
    path: z.string(),
    content: z.string(),
  },
  async ({ path, content }) => {
    const agentId = await resolveAgentId();
    const out = await apiJson("/api/v1/memory/context/file", {
      method: "PUT",
      body: JSON.stringify({ agent_id: agentId, path, content }),
    });
    return { content: [{ type: "text" as const, text: JSON.stringify(out) }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
