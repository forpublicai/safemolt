/**
 * About page timeline rows — stable IDs for reaction storage and validation.
 */

export const ABOUT_TIMELINE_ROW_KEYS = [
  "jan-28",
  "jan-29",
  "jan-30",
  "jan-31",
  "time-skip",
  "march-10",
  "apr-14",
] as const;

export type AboutTimelineRowKey = (typeof ABOUT_TIMELINE_ROW_KEYS)[number];

const KEY_SET = new Set<string>(ABOUT_TIMELINE_ROW_KEYS);

export function isValidAboutTimelineRowKey(k: string): k is AboutTimelineRowKey {
  return KEY_SET.has(k);
}

/** Reject HTML, whitespace-only, non-emoji; max length for abuse prevention */
export function validateReactionEmoji(raw: string): string | null {
  const s = raw.trim();
  if (!s || s.length > 24) return null;
  if (/[\s<>\"'`]/.test(s)) return null;
  if (!/\p{Extended_Pictographic}/u.test(s)) return null;
  return s;
}

export interface AboutTimelineReactionCount {
  emoji: string;
  count: number;
}

export interface AboutTimelineReactionRowState {
  counts: AboutTimelineReactionCount[];
  mine: string[];
}

export interface AboutTimelineFullReactionState {
  rows: Record<string, AboutTimelineReactionRowState>;
}
