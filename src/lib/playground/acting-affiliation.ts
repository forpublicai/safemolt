/**
 * Unverified “acting as” AO / entity labels for AO playground joins.
 * Not proof of roster membership — exploratory scenarios only.
 */

import type { SessionParticipant } from "./types";

const ACTING_LABEL_MAX = 200;

/** Bound and trim free-text claim from join bodies. */
export function sanitizeActingLabel(raw: unknown): string | undefined {
  if (raw == null) return undefined;
  if (typeof raw !== "string") return undefined;
  const t = raw.trim();
  if (!t) return undefined;
  return t.length > ACTING_LABEL_MAX ? t.slice(0, ACTING_LABEL_MAX) : t;
}

/** Max length 120 total: leading alnum plus up to 119 trailing safe chars. */
const COMPANY_ID_SAFE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/;

/** Normalize optional company slug/id from API (snake: acting_as_company_id). Invalid shapes are dropped. */
export function sanitizeActingCompanyId(raw: unknown): string | undefined {
  if (raw == null) return undefined;
  if (typeof raw !== "string") return undefined;
  const t = raw.trim();
  if (!t) return undefined;
  if (!COMPANY_ID_SAFE.test(t)) return undefined;
  return t;
}

/** Human-readable claim string stored on SessionParticipant / shown to GM. */
export async function buildActingDisplaySummary(opts: {
  getAoCompany: (id: string) => Promise<{ id: string; name: string } | null>;
  actingAsCompanyId?: string;
  actingAsLabel?: string;
}): Promise<string | undefined> {
  const cid = opts.actingAsCompanyId?.trim();
  let labelPart = "";

  let indexedPart = "";
  if (cid) {
    const company = await opts.getAoCompany(cid);
    if (company?.name?.trim()) {
      indexedPart = `${company.name.trim()} (${cid}, SafeMolt AO index)`;
    } else {
      indexedPart = `company id "${cid}" (not in SafeMolt AO index)`;
    }
  }

  if (opts.actingAsLabel?.trim()) {
    labelPart = opts.actingAsLabel.trim();
  }

  if (indexedPart && labelPart) {
    return `${indexedPart}; also claims: ${labelPart}`;
  }
  if (indexedPart) return indexedPart;
  if (labelPart) return labelPart;
  return undefined;
}

export interface ActingJoinPatch {
  actingAsCompanyId?: string;
  actingAsLabel?: string;
  actingAsDisplaySummary?: string;
}

/** Build optional affiliation fields after lookup (for new participant rows + merge retries). */
export async function resolveActingJoinPayload(opts: {
  getAoCompany: (id: string) => Promise<{ id: string; name: string } | null>;
  actingAsCompanyId?: string;
  actingAsLabel?: string;
}): Promise<ActingJoinPatch> {
  const actingAsCompanyId = opts.actingAsCompanyId?.trim() || undefined;
  const actingAsLabel = opts.actingAsLabel?.trim() || undefined;
  if (!actingAsCompanyId && !actingAsLabel) return {};

  const actingAsDisplaySummary = await buildActingDisplaySummary(opts);
  return {
    ...(actingAsCompanyId ? { actingAsCompanyId } : {}),
    ...(actingAsLabel ? { actingAsLabel } : {}),
    ...(actingAsDisplaySummary ? { actingAsDisplaySummary } : {}),
  };
}

const emptyStr = (v?: string): boolean => !(v ?? "").trim();

/** Fill only empty affiliation fields (merge-if-empty after idempotent joins). */
export function mergeAffiliationIntoParticipant(
  existing: SessionParticipant,
  patch: ActingJoinPatch
): { next: SessionParticipant; changed: boolean } {
  let changed = false;
  let next = { ...existing };

  if (!emptyStr(patch.actingAsCompanyId) && emptyStr(next.actingAsCompanyId)) {
    next = { ...next, actingAsCompanyId: patch.actingAsCompanyId!.trim() };
    changed = true;
  }
  if (!emptyStr(patch.actingAsLabel) && emptyStr(next.actingAsLabel)) {
    next = { ...next, actingAsLabel: patch.actingAsLabel!.trim() };
    changed = true;
  }
  if (!emptyStr(patch.actingAsDisplaySummary) && emptyStr(next.actingAsDisplaySummary)) {
    next = { ...next, actingAsDisplaySummary: patch.actingAsDisplaySummary!.trim() };
    changed = true;
  }

  return { next, changed };
}
