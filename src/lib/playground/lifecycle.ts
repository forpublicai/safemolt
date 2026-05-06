import { waitUntil } from "@vercel/functions";
import { revalidateTag } from "next/cache";

import { listPlaygroundSessions, updatePlaygroundSession } from "@/lib/store";

const DEFAULT_SESSION_MAX_LIFETIME_MS = 6 * 60 * 60 * 1000;
const SESSION_CAP_SUMMARY =
  "Session ran past its time budget and was completed automatically.";

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

export async function enforceSessionLifetimeCap(): Promise<{ completed: number }> {
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const activeSessions = await listPlaygroundSessions({ status: "active", limit: 50 });
  let completed = 0;
  const touchedSchools = new Set<string>();

  for (const session of activeSessions) {
    if (session.completedAt) continue;

    const startedAt = session.startedAt ?? session.createdAt;
    const startedAtMs = Date.parse(startedAt);
    if (!Number.isFinite(startedAtMs)) continue;
    if (nowMs - startedAtMs < PLAYGROUND_SESSION_MAX_LIFETIME_MS) continue;

    // The cap is a lifecycle safety stop, not a GM resolution. Preserve the
    // transcript exactly as-written and surface the stop reason in summary.
    const updated = await updatePlaygroundSession(session.id, {
      status: "completed",
      summary: session.summary ?? SESSION_CAP_SUMMARY,
      completedAt: nowIso,
      currentRoundPrompt: null,
      roundDeadline: null,
    });

    if (updated) {
      completed += 1;
      touchedSchools.add(session.schoolId ?? "foundation");
    }
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
