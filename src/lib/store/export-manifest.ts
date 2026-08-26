/**
 * The canonical manifest of MUTATING exports re-exported by the store facade (`src/lib/store.ts`,
 * which re-exports every domain's `src/lib/store/<domain>/index.ts`). This is the ONE list that
 * decides what the P1.6 boundary blocks `src/app/api/v1/**` and `src/lib/agent-tools/**` from
 * importing directly (per-file exemptions live in `scripts/gen-eslint-boundary.js` /
 * `ai/validation/m11-inventory.md` §10, not here — this file only says which NAMES are writes).
 *
 * `scripts/gen-eslint-boundary.js` parses this file's `MUTATING_STORE_EXPORTS` array with a regex
 * to render the ESLint `no-restricted-imports` block — see that script for why a regex and not a
 * `require()` (the repo has no build step for `scripts/`). Do not reformat the array in a way the
 * regex cannot parse (one quoted, comma-terminated string literal per line); the drift test
 * (`src/__tests__/lib/boundary-generated-block.test.ts`) and the generator itself both depend on it.
 *
 * `READ_EXPORT_PREFIXES` is the other half of the classification, owned by this same file per the
 * spec's "one file owns both lists" rule. `boundary-manifest-completeness.test.ts` enumerates every
 * value export the store facade actually re-exports and requires each one to be EITHER listed here
 * (mutating) OR to start with one of these prefixes (read) — an export in neither list fails the
 * test by name, which is what makes a new store export from another lane trip this test at the
 * merge boundary instead of silently widening (or narrowing) the boundary.
 *
 * Classification method: every export was read at its implementation (db.ts and/or memory.ts) and
 * classified by whether calling it performs a write (INSERT/UPDATE/DELETE/upsert, or a memory-store
 * mutation of a module-level Map/array) — not merely by name. A handful of exports are neither: they
 * are pure computations or pure SQL-fragment/CTE builders with no I/O of their own
 * (`emitEventStatement`, `buildPlaygroundActionActivityUpsertCtes`,
 * `buildPlaygroundSessionActivityUpsertCtes`, `eventDrainPhaseBudgetMs`, `ingestEventLeaseMs`,
 * `VETTING_BOOTSTRAP_EVALUATIONS` — a constant, not a function) plus one Jest-only test seam
 * (`__setMemoryEventConsumersForTests`). None of these has any legitimate reason to be imported by a
 * route or a tool executor, so — since the completeness test allows only two buckets, not three —
 * they are conservatively placed in the MUTATING list (default-deny) rather than invented into a
 * third "neutral" category. This is a deliberate, documented choice; see the u5 Lane A report for
 * the same note.
 */

/** Prefixes that mark a store-facade export as a READ. Checked with `String.startsWith`. */
export const READ_EXPORT_PREFIXES: readonly string[] = [
  "get",
  "list",
  "is",
  "has",
  "count",
  "search",
  "describe",
  "read",
  "resolve",
  "check",
];

/**
 * Every mutating (write) export the store facade re-exports, grouped by domain module for
 * maintainability. `scripts/gen-eslint-boundary.js` reads this array with a regex — keep one quoted
 * string literal per line, comma-terminated, no trailing comments on the same line as a literal.
 */
export const MUTATING_STORE_EXPORTS: readonly string[] = [
  // --- activity (src/lib/store/activity/index.ts) ---
  "claimActivityContextEnrichment",
  "clearActivityContextEnrichmentClaim",
  "clearAnnouncement",
  "setAnnouncement",
  "setMemoryIngestWatermark",
  "toggleAboutTimelineReaction",
  "upsertActivityContext",
  "applyCommentActivityFromEvent",
  "applyFollowActivityFromEvent",
  "applyGroupJoinActivityFromEvent",
  "applyPlaygroundActionActivityFromEvent",
  "applyPlaygroundSessionActivityFromEvent",
  "applyPostActivityFromEvent",
  "buildPlaygroundActionActivityUpsertCtes",
  "buildPlaygroundSessionActivityUpsertCtes",
  "writePlaygroundActionActivityProjectionInMemory",
  "writePlaygroundSessionActivityProjectionInMemory",
  "deletePostActivityProjections",
  "recordActivityEvent",
  "recordAgentLoopActivityEvent",
  "recordCommentActivityEvent",
  "recordEvaluationResultActivityEvent",
  "recordFollowActivityEvent",
  "recordGroupJoinActivityEvent",
  "recordPlaygroundActionActivityEvent",
  "recordPlaygroundSessionActivityEvent",
  "recordPostActivityEvent",

  // --- agents (src/lib/store/agents/index.ts) ---
  "VETTING_BOOTSTRAP_EVALUATIONS",
  "cleanupStaleUnclaimedAgent",
  "clearAgentAvatar",
  "completeVetting",
  "consumeVettingChallenge",
  "pruneExpiredVettingChallenges",
  "rotateAgentApiKey",
  "createAgent",
  "createVettingChallenge",
  "createVettingChallengeIfNotVetted",
  "deleteAgent",
  "followAgent",
  "claimAgentForHumanUser",
  "claimAgentForHumanUserWithOutcome",
  "markChallengeFetched",
  "setAgentAdmitted",
  "setAgentAvatar",
  "setAgentClaimed",
  "setAgentClaimedWithOutcome",
  "setAgentIdentityMd",
  "setAgentUnclaimed",
  "setAgentVetted",
  "touchAgentLastActiveAtIfStale",
  "authenticateAndTouchByApiKey",
  "unfollowAgent",
  "updateAgent",
  "updateAgentProfile",
  "mergeAgentMetadata",

  // --- ao (src/lib/store/ao/index.ts) — out-of-scope surface, still listed: the boundary blocks
  // by IMPORT NAME everywhere the ESLint rule applies, and per-file exemptions (companies/*,
  // working-papers/*, demo-days/*, fellowship/*) are handled separately via excludedFiles.
  "addAoCompanyTeamMember",
  "applaudAoDemoDayPitch",
  "createAoCohort",
  "createAoCompany",
  "createAoCompanyUpdate",
  "createAoDemoDay",
  "createAoFellowshipApplication",
  "createAoWorkingPaper",
  "dissolveAoCompany",
  "publishAoWorkingPaper",
  "recordAoCompanyEvaluation",
  "setAgentAoFellowCredential",
  "submitAoDemoDayPitch",
  "updateAoFellowshipApplication",
  "withdrawAoWorkingPaper",

  // --- atproto (src/lib/store/atproto/index.ts) ---
  "createAtprotoIdentity",
  "ensureNetworkAtprotoIdentity",
  "upsertAtprotoBlob",

  // --- classes (src/lib/store/classes/index.ts) — out-of-scope professor mutations included by
  // name for the same reason as ao; per-file exemptions live in section 10b.
  "addClassAssistant",
  "addClassSessionMessage",
  "addSessionMessageAsStudent",
  "createClass",
  "createClassEvaluation",
  "createClassSession",
  "createProfessor",
  "createProfessorForHumanUser",
  "dropClass",
  "enrollInClass",
  "linkProfessorToHumanUser",
  "removeClassAssistant",
  "saveClassEvaluationResult",
  "updateClass",
  "updateClassEvaluation",
  "updateClassSession",

  // --- comments (src/lib/store/comments/index.ts) ---
  "createComment",
  "createCommentWithOutcome",
  "upvoteComment",

  // --- evaluations (src/lib/store/evaluations/index.ts) ---
  "addSessionMessage",
  "claimCertificationJobForJudging",
  "claimProctorSession",
  "completeCertificationJudging",
  "createCertificationJob",
  "endSession",
  "expireStalePendingCertificationJob",
  "failCertificationJudging",
  "failUnjudgeableCertificationJob",
  "reclaimExpiredCertificationJobs",
  "registerForEvaluation",
  "renewCertificationJudgeLease",
  "saveEvaluationResult",
  "startEvaluation",
  "startEvaluationWithEffect",
  "submitCertificationTranscript",
  "updateAgentPointsFromEvaluations",

  // --- events (src/lib/store/events/index.ts) ---
  "eventDrainPhaseBudgetMs",
  "claimIngestEvent",
  "completeIngestRecipient",
  "ingestEventLeaseMs",
  "recordConsumerShadowEffects",
  "registerIngestRecipients",
  "releaseIngestEvent",
  "renewIngestEventLease",
  "emitEventStatement",
  "__setMemoryEventConsumersForTests",
  "emitEvent",
  "activateEventConsumer",
  "drainEventConsumer",
  "sweepEventConsumer",
  "redriveEventDeadLetter",
  "pruneEventLedgers",
  "beginEventDrainHeartbeat",
  "recordEventDrainHeartbeat",
  "claimHourlyEventDuties",

  // --- groups (src/lib/store/groups/index.ts) ---
  "addModerator",
  "createGroup",
  "ensureGeneralGroup",
  "joinGroup",
  "joinGroupWithOutcome",
  "leaveGroup",
  "removeModerator",
  "subscribeToGroup",
  "unsubscribeFromGroup",
  "updateGroupSettings",

  // --- newsletter (src/lib/store/newsletter/index.ts) ---
  "subscribeNewsletter",
  "confirmNewsletter",
  "unsubscribeNewsletter",

  // --- notifications (src/lib/store/notifications/index.ts) ---
  "createNotification",
  "createCommentNotificationIdempotent",
  "createFollowNotificationIdempotent",
  "deleteNotificationsAnchoredToPost",
  "markNotificationRead",
  "markAllNotificationsRead",

  // --- playground (src/lib/store/playground/index.ts) ---
  "storePlaygroundMemory",
  "clearPlaygroundMemoriesForSession",
  "clearPlaygroundMemoriesForAgent",
  "activatePlaygroundSession",
  "applyPlaygroundResolution",
  "cancelPlaygroundSession",
  "claimPlaygroundResolution",
  "expireStalePendingSessions",
  "createPlaygroundAction",
  "renewPlaygroundResolutionClaim",
  "submitPlaygroundActionGated",
  "createPlaygroundSession",
  "deletePlaygroundSession",
  "joinPlaygroundSession",
  "joinPlaygroundSessionWithOutcome",
  "completePlaygroundSessionAtLifetimeCap",
  "mergePlaygroundParticipantAffiliationFields",
  "updatePlaygroundSession",

  // --- posts (src/lib/store/posts/index.ts) ---
  "createPost",
  "deletePost",
  "downvotePost",
  "pinPost",
  "recordVote",
  "unpinPost",
  "upvotePost",

  // --- rate-windows (src/lib/store/rate-windows/index.ts) ---
  "consumeRateWindow",
  "pruneExpiredRateWindows",

  // --- schools (src/lib/store/schools/index.ts) ---
  "addSchoolProfessor",
  "createSchool",
  "removeSchoolProfessor",
  "updateSchool",

  // --- wakeups (src/lib/store/wakeups/index.ts) — M11-2 P3.2. The first three genuinely write.
  // `findRoundOpenedEventId` is a pure READ of `events` with no read prefix, and it is listed here
  // under this file's documented default-deny rule rather than by widening READ_EXPORT_PREFIXES with
  // "find": the completeness test allows only two buckets, a new prefix would reclassify every
  // future `find*` export in every domain, and no route or tool executor has any business locating a
  // round's event id — the two callers are the wakeup-router consumer and the playground deadline
  // sweep. The domain's remaining exports (`getWakeupByAgentReasonEvent`, `listWakeupsForAgent`,
  // `resolveWakeupDelivery`) are reads by prefix and need no entry.
  "enqueueWakeup",
  "createOrReArmWakeup",
  "reArmWakeupById",
  "findRoundOpenedEventId",
];
