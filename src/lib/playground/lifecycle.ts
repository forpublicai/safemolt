import { waitUntil } from "@vercel/functions";
import { revalidateTag } from "next/cache";

import { completePlaygroundSessionAtLifetimeCap, listSessionsDueForLifetimeCap } from "@/lib/store";
import { playgroundSessionCompletedEvent } from "@/lib/actions/playground-events";

const DEFAULT_SESSION_MAX_LIFETIME_MS = 6 * 60 * 60 * 1000;
const SESSION_CAP_SUMMARY =
  "Session ran past its time budget and was completed automatically.";

/** How many due sessions one query returns, and how many such queries one sweep makes. */
const LIFETIME_CAP_PAGE_SIZE = 50;
const LIFETIME_CAP_MAX_PAGES = 20;

type DeadlineRunner = () => Promise<Partial<PlaygroundDeadlineRunResult> | void>;

export interface PlaygroundDeadlineRunResult {
  advanced: number;
  capped: number;
  advanceDurationMs?: number;
  capDurationMs?: number;
}

export const PLAYGROUND_SESSION_MAX_LIFETIME_MS = (() => {
  const raw = Number(process.env.PLAYGROUND_SESSION_MAX_LIFETIME_MS ?? DEFAULT_SESSION_MAX_LIFETIME_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_SESSION_MAX_LIFETIME_MS;
})();

const inflightDeadlineRuns = new Set<string>();

export function safeWaitUntil(promise: Promise<unknown>, label: string): void {
  const tagged = promise.catch((error) => {
    console.error(`[playground/lifecycle] ${label} failed`, error);
  });

  try {
    waitUntil(tagged);
  } catch {
    void tagged;
  }
}

export function revalidatePlaygroundSeed(schoolId?: string): void {
  try {
    revalidateTag(`playground-seed:${schoolId ?? "foundation"}`);
  } catch (error) {
    console.warn("[playground/lifecycle] Failed to revalidate playground seed", error);
  }
}

/**
 * Complete every session that has outlived its budget — **oldest first, and paged**
 * (u3d fix round, finding 4).
 *
 * This used to read the 50 NEWEST active sessions and filter them by age here. That window is the
 * defect: with 51 live sessions the oldest is not in it at all, so a session that had already blown
 * its budget was skipped by every sweep while the newest 50 were still young, and continuous
 * creation stranded it indefinitely. The store now answers with the sessions that are DUE, ordered by
 * `COALESCE(started_at, created_at)` ascending — so the sweep always sees the ones that have waited
 * longest — and this pages until a page comes back short.
 *
 * **The page cursor is the predicate, not an offset.** Every returned row is `status = 'active'` with
 * `completed_at IS NULL`, and the conditional completion either changes one of those columns or loses
 * to a writer that already did, so a processed row cannot come back on the next page. An offset would
 * instead skip rows whenever a concurrent completion shifted the window.
 *
 * `LIFETIME_CAP_MAX_PAGES` bounds one invocation rather than the backlog: the ordering means the next
 * run resumes at the oldest sessions still due, so a backlog drains across runs instead of starving.
 */
export async function enforceSessionLifetimeCap(): Promise<{ completed: number }> {
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const cutoff = new Date(nowMs - PLAYGROUND_SESSION_MAX_LIFETIME_MS).toISOString();
  let completed = 0;
  const touchedSchools = new Set<string>();

  for (let page = 0; page < LIFETIME_CAP_MAX_PAGES; page += 1) {
    const due = await listSessionsDueForLifetimeCap(cutoff, LIFETIME_CAP_PAGE_SIZE);
    if (due.length === 0) break;

    for (const session of due) {
      // The cap is a lifecycle safety stop, not a GM resolution. Preserve the
      // transcript exactly as-written and surface the stop reason in summary.
      //
      // **Conditional since u3d, and that is what lets it carry an event.** It used to run through
      // the generic `updatePlaygroundSession`, whose `WHERE id = $1` matches whatever it finds and
      // whose boolean is an unconditional `true` — so two overlapping sweeps, or a sweep racing a
      // genuine GM completion, would each have "succeeded" and each emitted. The predicate below is
      // what the caller actually means, so exactly one writes and exactly one event exists.
      const updated = await completePlaygroundSessionAtLifetimeCap(
        session.id,
        { summary: session.summary ?? SESSION_CAP_SUMMARY, completedAt: nowIso },
        [
          playgroundSessionCompletedEvent({
            sessionId: session.id,
            schoolId: session.schoolId ?? null,
            reason: "lifetime_cap",
          }),
        ]
      );

      if (updated) {
        completed += 1;
        touchedSchools.add(session.schoolId ?? "foundation");
      }
    }

    if (due.length < LIFETIME_CAP_PAGE_SIZE) break;
  }

  for (const schoolId of touchedSchools) {
    revalidatePlaygroundSeed(schoolId);
  }

  return { completed };
}

export async function runDeadlinesAndCap(
  label: string,
  runDeadlineCheck?: DeadlineRunner
): Promise<PlaygroundDeadlineRunResult> {
  if (inflightDeadlineRuns.has(label)) {
    return { advanced: 0, capped: 0 };
  }

  inflightDeadlineRuns.add(label);
  try {
    const result = runDeadlineCheck
      ? await runDeadlineCheck()
      : await import("@/lib/playground/session-manager").then(({ checkDeadlines }) => checkDeadlines());
    return {
      advanced: result?.advanced ?? 0,
      capped: result?.capped ?? 0,
      advanceDurationMs: result?.advanceDurationMs,
      capDurationMs: result?.capDurationMs,
    };
  } finally {
    inflightDeadlineRuns.delete(label);
  }
}
