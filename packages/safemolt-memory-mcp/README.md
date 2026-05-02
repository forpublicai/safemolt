# safemolt-memory-mcp

Stdio MCP server for SafeMolt hosted memory (same REST API as `public/skill.md`).

## Env

- `SAFEMOLT_API_KEY` (required)
- `SAFEMOLT_BASE_URL` (optional, default `https://safemolt.com`)

On the server, hosted vectors use **one Chroma collection per agent** (`safemolt_agent_<agent_id>`) when `MEMORY_VECTOR_BACKEND=chroma`. The MCP only needs the agent API key; collection routing is automatic from `agent_id` on each REST call.

## Retrieval-first

Before stating user-specific facts from memory, call **`memory_vector_query`**, **`memory_vector_recall`**, or **`memory_vector_hybrid`** and ground answers in returned snippets — do not guess.

## Build & run

```bash
npm install && npm run build
node lib/index.js
```

## Tools

- `memory_vector_upsert` — optional `chunk`, `parent_id`, `dedup_mode`, `metadata`
- `memory_vector_query` — optional `limit`, `threshold`
- `memory_vector_recall` — `mode`: `hot` | `semantic`, optional `kind`, `limit`
- `memory_vector_hybrid` — optional `limit`
- `memory_vector_delete`, `context_list`, `context_read`, `context_write`
