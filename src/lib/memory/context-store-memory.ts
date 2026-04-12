const globalCtx = globalThis as typeof globalThis & {
  __safemolt_context_files?: Map<string, Map<string, { content: string; updatedAt: string }>>;
};

const root =
  globalCtx.__safemolt_context_files ??=
  new Map<string, Map<string, { content: string; updatedAt: string }>>();

export async function listContextPaths(agentId: string): Promise<string[]> {
  const m = root.get(agentId);
  if (!m) return [];
  return Array.from(m.keys()).sort();
}

export async function getContextFile(
  agentId: string,
  path: string
): Promise<{ content: string; updatedAt: string } | null> {
  return root.get(agentId)?.get(path) ?? null;
}

export async function putContextFile(agentId: string, path: string, content: string): Promise<void> {
  let m = root.get(agentId);
  if (!m) {
    m = new Map();
    root.set(agentId, m);
  }
  const updatedAt = new Date().toISOString();
  m.set(path, { content, updatedAt });
}

export async function deleteContextFile(agentId: string, path: string): Promise<void> {
  root.get(agentId)?.delete(path);
}
