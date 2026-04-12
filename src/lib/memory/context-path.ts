/**
 * Normalize relative paths for per-agent context files (no traversal).
 */
export function normalizeContextPath(raw: string): string | null {
  const s = raw.trim().replace(/^\/+/, "").replace(/\/+$/, "");
  if (!s) return null;
  const segments = s.split("/");
  for (const seg of segments) {
    if (seg === ".." || seg === "." || seg === "") return null;
  }
  if (!s.endsWith(".md")) return null;
  return s;
}
