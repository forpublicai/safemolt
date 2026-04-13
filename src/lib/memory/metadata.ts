/**
 * Canonical memory metadata: normalize caller input for Chroma + docs.
 * See public/skill.md (Hosted memory).
 */

const MAX_META_STRING = 2048;
const MAX_SUMMARY_CHARS = 4000;

export type NormalizedMemoryMetadata = Record<string, string | number | boolean>;

function clampStr(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max);
}

/** Parse importance to a finite number or undefined. */
export function parseImportance(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/**
 * Merge server defaults with caller metadata. Strips unknown nesting by stringifying
 * in chroma-provider flattenMeta; here we coerce known keys and sizes.
 */
export function normalizeMemoryMetadata(
  caller: Record<string, unknown> | undefined,
  defaults: { source: string; filed_at?: string }
): NormalizedMemoryMetadata {
  const fromCaller =
    caller && typeof caller.filed_at === "string" && caller.filed_at.length > 0
      ? clampStr(caller.filed_at, 48)
      : undefined;
  const out: NormalizedMemoryMetadata = {
    source: defaults.source,
    filed_at: fromCaller ?? defaults.filed_at ?? new Date().toISOString(),
  };
  if (!caller) return out;

  const kind = caller.kind;
  if (typeof kind === "string" && kind.length > 0) {
    out.kind = clampStr(kind, 128);
  }

  for (const key of [
    "source_ref",
    "parent_id",
    "session_id",
    "provenance",
    "post_id",
    "comment_id",
    "author_id",
  ] as const) {
    const v = caller[key];
    if (typeof v === "string" && v.length > 0) {
      out[key] = clampStr(v, MAX_META_STRING);
    }
  }

  const round = caller.round;
  if (typeof round === "number" && Number.isInteger(round)) {
    out.round = round;
  }

  const chunkIndex = caller.chunk_index;
  if (typeof chunkIndex === "number" && Number.isInteger(chunkIndex) && chunkIndex >= 0) {
    out.chunk_index = chunkIndex;
  }

  const imp = parseImportance(caller.importance);
  if (imp !== undefined) {
    out.importance = Math.max(0, Math.min(1_000_000, imp));
  }

  const summary = caller.summary;
  if (typeof summary === "string" && summary.length > 0) {
    out.summary = clampStr(summary, MAX_SUMMARY_CHARS);
  }

  // Pass through other primitive-safe keys for forward compatibility (still size-clamped).
  for (const [k, v] of Object.entries(caller)) {
    if (k in out) continue;
    if (
      [
        "kind",
        "source_ref",
        "parent_id",
        "session_id",
        "provenance",
        "post_id",
        "comment_id",
        "author_id",
        "round",
        "chunk_index",
        "importance",
        "summary",
        "agent_id",
        "source",
      ].includes(k)
    ) {
      continue;
    }
    if (typeof v === "string") {
      out[k] = clampStr(v, MAX_META_STRING);
    } else if (typeof v === "number" && Number.isFinite(v)) {
      out[k] = v;
    } else if (typeof v === "boolean") {
      out[k] = v;
    }
  }

  return out;
}
