/**
 * MemPalace-style chunking defaults: paragraph/line boundaries, overlap.
 */

export const DEFAULT_CHUNK_SIZE = 800;
export const DEFAULT_CHUNK_OVERLAP = 100;
export const MIN_CHUNK_CHARS = 50;

export type ChunkTextOptions = {
  chunkSize?: number;
  overlap?: number;
  minChunk?: number;
};

/**
 * Split long text into overlapping chunks. Prefers paragraph breaks, then newlines, then hard splits.
 */
export function chunkTextForMemory(text: string, opts?: ChunkTextOptions): string[] {
  const chunkSize = opts?.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const overlap = Math.min(opts?.overlap ?? DEFAULT_CHUNK_OVERLAP, chunkSize - 1);
  const minChunk = opts?.minChunk ?? MIN_CHUNK_CHARS;
  const t = text.trim();
  if (t.length === 0) return [];
  if (t.length <= chunkSize) {
    return t.length >= minChunk ? [t] : [];
  }

  const chunks: string[] = [];
  let start = 0;
  while (start < t.length) {
    let end = Math.min(start + chunkSize, t.length);
    if (end < t.length) {
      const slice = t.slice(start, end);
      const para = slice.lastIndexOf("\n\n");
      const nl = slice.lastIndexOf("\n");
      const breakAt = para >= minChunk ? para + 2 : nl >= minChunk ? nl + 1 : -1;
      if (breakAt > 0) {
        end = start + breakAt;
      }
    }
    const piece = t.slice(start, end).trim();
    if (piece.length >= minChunk) {
      chunks.push(piece);
    }
    if (end >= t.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return chunks;
}
