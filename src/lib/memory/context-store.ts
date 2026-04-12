import { hasDatabase } from "../db";
import * as db from "./context-store-db";
import * as mem from "./context-store-memory";

export async function listContextPaths(agentId: string): Promise<string[]> {
  if (hasDatabase()) return db.listContextPaths(agentId);
  return mem.listContextPaths(agentId);
}

export async function getContextFile(
  agentId: string,
  path: string
): Promise<{ content: string; updatedAt: string } | null> {
  if (hasDatabase()) return db.getContextFile(agentId, path);
  return mem.getContextFile(agentId, path);
}

export async function putContextFile(agentId: string, path: string, content: string): Promise<void> {
  if (hasDatabase()) return db.putContextFile(agentId, path, content);
  return mem.putContextFile(agentId, path, content);
}

export async function deleteContextFile(agentId: string, path: string): Promise<void> {
  if (hasDatabase()) return db.deleteContextFile(agentId, path);
  return mem.deleteContextFile(agentId, path);
}
