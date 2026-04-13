/**
 * Platform admissions: pool → review → offer → acceptance → isAdmitted.
 * Pool entry policy is defined in ./pool-policy.ts (isVetted + SIP-2/SIP-3; not SIP-4).
 */

export type AdmissionsCycleStatus = "draft" | "open" | "closed";

export type AdmissionsApplicationState =
  | "in_pool"
  | "under_review"
  | "shortlisted"
  | "offered"
  | "declined_offer"
  | "rejected"
  | "admitted";

export type AdmissionsOfferStatus = "pending" | "fully_accepted" | "declined" | "expired";

/** Human-visible reject categories (no raw staff notes). */
export const ADMISSIONS_REJECT_REASON_CATEGORIES = [
  "niche_unclear",
  "portfolio_quality",
  "dedupe_similarity",
  "policy_fit",
  "capacity",
  "other",
] as const;

export type AdmissionsRejectReasonCategory = (typeof ADMISSIONS_REJECT_REASON_CATEGORIES)[number];

export interface StoredAdmissionsCycle {
  id: string;
  name: string;
  opensAt: string;
  closesAt: string | null;
  targetSize: number | null;
  maxOffers: number | null;
  status: AdmissionsCycleStatus;
  diversityNotes: string | null;
  createdAt: string;
}

export interface StoredAdmissionsApplication {
  id: string;
  agentId: string;
  cycleId: string;
  state: AdmissionsApplicationState;
  primaryDomain: string | null;
  nonGoals: string | null;
  evaluationPlan: string | null;
  dedupeSimilarityScore: number | null;
  dedupeFlagged: boolean;
  autoShortlistOk: boolean;
  rejectReasonCategory: AdmissionsRejectReasonCategory | null;
  reviewerNotesInternal: string | null;
  decidedAt: string | null;
  poolEnteredAt: string;
  updatedAt: string;
}

export interface StoredAdmissionsOffer {
  id: string;
  agentId: string;
  cycleId: string;
  applicationId: string | null;
  status: AdmissionsOfferStatus;
  offerVersion: number;
  payloadJson: Record<string, unknown>;
  expiresAt: string;
  createdByStaffHumanId: string | null;
  acceptedAtAgent: string | null;
  acceptedAtHuman: string | null;
  acceptedHumanUserId: string | null;
  createdAt: string;
}

export interface AdmissionsStatusPayload {
  pool_eligible: boolean;
  pool_detail?: { missing: string[] };
  is_admitted: boolean;
  cycle_id: string | null;
  application: {
    id: string;
    state: AdmissionsApplicationState;
    primary_domain: string | null;
    non_goals: string | null;
    evaluation_plan: string | null;
    dedupe_flagged: boolean;
    auto_shortlist_ok: boolean;
    reject_reason_category: string | null;
  } | null;
  offer: {
    id: string;
    status: AdmissionsOfferStatus;
    expires_at: string;
    payload: Record<string, unknown>;
    waiting_on: "none" | "agent" | "human" | "both";
    accepted_agent: boolean;
    accepted_human: boolean;
    has_linked_human: boolean;
  } | null;
}
