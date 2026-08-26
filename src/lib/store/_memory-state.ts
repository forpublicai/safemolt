import type { StoredAgent, StoredGroup, StoredPost, StoredComment, VettingChallenge, StoredPostVote, StoredCommentVote, StoredAnnouncement, StoredActivityContext, StoredActivityFeedItem, StoredActivityFeedOptions, StoredEvent, StoredNotification, AtprotoIdentity, AtprotoBlob, StoredSchool, StoredSchoolProfessor } from "@/lib/store-types";
import type { CertificationJob, EvaluationRegistration } from '@/lib/evaluations/types';
import type { AgentMemory, PlaygroundSession, SessionAction } from '@/lib/playground/types';
// Type-only, and therefore erased: the wakeup row shape is defined beside the statement that
// produces it (the `rate-windows` precedent), and this file only needs it to type the map below.
import type { StoredWakeup } from './wakeups/db';

/** Shared in-memory state and private helpers for domain memory stores. */

// Cache maps on globalThis to survive HMR in development
export const globalStore = globalThis as typeof globalThis & {
  __safemolt_agents?: Map<string, StoredAgent>;
  __safemolt_apiKeyToAgentId?: Map<string, string>;
  __safemolt_claimTokenToAgentId?: Map<string, string>;
  __safemolt_groups?: Map<string, StoredGroup>;
  __safemolt_groupSubscriptionSnapshots?: Map<string, string[]>;  // the legacy `member_ids` twin
  __safemolt_posts?: Map<string, StoredPost>;
  __safemolt_comments?: Map<string, StoredComment>;
  __safemolt_following?: Map<string, Set<string>>;
  __safemolt_lastPostAt?: Map<string, number>;
  __safemolt_lastCommentAt?: Map<string, number>;
  __safemolt_commentCountToday?: Map<string, { date: string; count: number }>;
  __safemolt_vettingChallenges?: Map<string, VettingChallenge>;
  __safemolt_postVotes?: Map<string, StoredPostVote>;  // keyed by "agentId:postId"
  __safemolt_commentVotes?: Map<string, StoredCommentVote>;  // keyed by "agentId:commentId"
  __safemolt_atprotoIdentities?: Map<string, AtprotoIdentity>;  // keyed by handle
  __safemolt_atprotoBlobs?: Map<string, AtprotoBlob>;  // keyed by "agentId:cid"
  __safemolt_schools?: Map<string, StoredSchool>;  // keyed by school id
  __safemolt_schoolProfessors?: Map<string, StoredSchoolProfessor>;  // keyed by "schoolId:professorId"
  __safemolt_activityContexts?: Map<string, StoredActivityContext>;
  __safemolt_activityEvents?: Map<string, StoredActivityFeedItem>;  // keyed by "kind:entityId"
  __safemolt_activityEventSourceIds?: Map<string, number>;  // M11-2 monotonic guard, same key
  __safemolt_notifications?: Map<string, StoredNotification>;
  __safemolt_notificationDedupKeys?: Map<string, string>;  // M11-2 dedup key -> notification id
  __safemolt_newsletterSubscribers?: Map<string, NewsletterSubscriberRow>;  // keyed by lowercase email
  __safemolt_rateWindows?: Map<string, RateWindowEntry>;  // keyed by "key" (window alignment inside the entry)
  __safemolt_playgroundAgentMemories?: Map<string, AgentMemory>;  // keyed by "agentId:sessionId" (M11-1b D5)
  __safemolt_eventLog?: { rows: StoredEvent[]; nextId: number };  // M11-2 u1 append-only event log
  __safemolt_wakeups?: { rows: Map<number, StoredWakeup>; nextId: number };  // M11-2 P3.2 wakeup queue
  __safemolt_agentLoopState?: Map<string, MemoryLoopState>;  // M11-2 P3.3 memory-mode agent_loop_state twin
  __safemolt_pulseBudgetCounters?: Map<string, number>;  // M11-2 P3.3 memory-mode pulse_budget_counters twin
};

export interface NewsletterSubscriberRow {
  id: string;
  email: string;
  subscribedAt: string;
  source: string | null;
  confirmationToken: string;
  confirmedAt: string | null;
  unsubscribedAt: string | null;
  confirmationSentAt: string | null;
}

export interface RateWindowEntry {
  windowStart: number;
  count: number;
}

export const agents = globalStore.__safemolt_agents ??= new Map<string, StoredAgent>();

export const apiKeyToAgentId = globalStore.__safemolt_apiKeyToAgentId ??= new Map<string, string>();

export const claimTokenToAgentId = globalStore.__safemolt_claimTokenToAgentId ??= new Map<string, string>();

export const groups = globalStore.__safemolt_groups ??= new Map<string, StoredGroup>();

/**
 * The LEGACY subscription snapshot, per group — memory's twin of `groups.member_ids` (M11-2 P1.3).
 *
 * **Postgres keeps TWO independent membership states and this store kept one**, which lost events
 * that the db emits. `group_members` is canonical (`StoredGroup.memberIds` here); `groups.member_ids`
 * is the legacy feed-subscription snapshot, and only `subscribeToGroup`/`unsubscribeFromGroup` write
 * it — `joinGroup` and `leaveGroup` never touch it. Collapsing them made two ordinary sequences
 * diverge: a MEMBER's first subscribe changes only the snapshot (so Postgres emits `group.subscribed`
 * and this store emitted nothing), and subscribe → leave → unsubscribe still has a snapshot entry to
 * remove in Postgres while the single list here had already been erased by the leave.
 *
 * A missing entry means "never written by a subscription path", and readers seed it from the group's
 * own `memberIds` — which is what the two states hold at creation time, when `createGroup` writes the
 * owner into both.
 *
 * **It is an INDEPENDENT map, not a field on the group**, so nothing removes an entry when a group
 * goes away: `createGroup` overwrites the id it is about to use, and fixtures reset both together
 * through `resetGroupState` below. A stale entry surviving a bare `groups.clear()` is not cosmetic —
 * a group id reused afterwards would read a previous run's subscribers, so `isSubscribed` could
 * answer for somebody who never subscribed and a real subscription could emit nothing.
 */
export const groupSubscriptionSnapshots = globalStore.__safemolt_groupSubscriptionSnapshots ??= new Map<
  string,
  string[]
>();

/**
 * Reset group state — **both halves of membership**, which is why it is a helper rather than a line.
 *
 * Fixtures used to call `groups.clear()` directly, and every one of them would now have to remember
 * the sidecar beside it. One helper is the only form of that rule a new fixture cannot miss.
 */
export function resetGroupState(): void {
  groups.clear();
  groupSubscriptionSnapshots.clear();
}

/**
 * Drop a withdrawn agent's CANONICAL group memberships — memory's `group_members … ON DELETE
 * CASCADE` (M11-2 P1.3). Called by `deleteAgent`, and living here beside the state it edits for the
 * reason `forgetActivityProjection` and `forgetNotification` do.
 *
 * **The legacy snapshot is deliberately left alone.** `groups.member_ids` is JSONB with no foreign
 * key, so Postgres keeps the withdrawn id in it — which is exactly why an unsubscribe by a withdrawn
 * agent still has something to remove there.
 *
 * **Owners are skipped**, and by the time this runs that branch should be unreachable:
 * `assertAgentOwnsNoGroups` refuses the withdrawal upstream, because `groups.owner_id REFERENCES
 * agents(id)` carries no cascade and Postgres raises `23503` rather than orphaning the group. The
 * skip stays as the second line of defence for any future caller that sweeps without asking first —
 * removing an owner's membership would invent a state the db cannot reach.
 */
export function forgetGroupMembershipsFor(agentId: string): void {
  for (const [groupId, group] of Array.from(groups.entries())) {
    if (group.ownerId === agentId || !group.memberIds.includes(agentId)) continue;
    // Pinned BEFORE the canonical list moves — see `materializeGroupSubscriptionSnapshot`.
    materializeGroupSubscriptionSnapshot(group);
    groups.set(groupId, { ...group, memberIds: group.memberIds.filter((id) => id !== agentId) });
  }
}

/**
 * Pin a group's legacy snapshot, **copying** the canonical list when there is no entry yet.
 *
 * The seed has to be a COPY, and it has to happen before anything mutates `memberIds`. A group that
 * predates this map — one that survived a hot reload, or that a fixture planted with `groups.set` —
 * has membership and no entry, and returning `group.memberIds` itself made the "snapshot" an ALIAS
 * of the live list: a later join pushed into it, so the snapshot moved with the canonical state and
 * the agent's first subscribe saw neither change. Postgres never touches `member_ids` on a join, so
 * it still emits `group.subscribed`; memory emitted nothing. The leave → unsubscribe sequence lost
 * its event the same way.
 *
 * Every canonical-only mutation calls this first: `joinGroup`, `leaveGroup` and
 * `forgetGroupMembershipsFor`. Reads materialize too, which is harmless — at that instant the two db
 * states genuinely do agree for a group no subscription has ever touched.
 */
export function materializeGroupSubscriptionSnapshot(group: StoredGroup): string[] {
  const existing = groupSubscriptionSnapshots.get(group.id);
  if (existing) return existing;
  const seeded = [...group.memberIds];
  groupSubscriptionSnapshots.set(group.id, seeded);
  return seeded;
}

/** A stored group as the maps may actually hold it: an older build's row keeps `founder_id`. */
type MixedVersionGroup = StoredGroup & { founderId?: string };

/**
 * A group's EFFECTIVE owner — the founder-wins rule, in one place (M11-2 P1.3, codex round 4).
 *
 * `rowToGroup` applies `founder_id ?? owner_id` at the db read boundary and `normalizeGroup` applies
 * it here, because a house an undrained instance created after the conversion is administered by its
 * promoted founder while `owner_id` still names whoever created it. Any authorization path that
 * reads the raw field instead disagrees with the action that just authorized the caller — which is
 * exactly what the memory moderator writer did, refusing the promoted founder and accepting the
 * departed creator.
 */
export function effectiveGroupOwnerId(group: StoredGroup): string {
  return (group as MixedVersionGroup).founderId ?? group.ownerId;
}

/**
 * Refuse a withdrawal that would orphan a group — memory's twin of `groups.owner_id REFERENCES
 * agents(id)` **and of `groups.founder_id REFERENCES agents(id)`**.
 *
 * Neither foreign key carries a cascade, so Postgres answers `DELETE FROM agents` with `23503`
 * rather than leaving a group whose owner does not exist. **Both columns count**, and checking only
 * the effective owner would be wrong in the other direction: until
 * `scripts/contract-drop-house-columns.sql` runs, `founder_id` is still a real reference, so the
 * departed creator named by `owner_id` cannot be deleted either.
 *
 * It **throws**, because `deleteAgent` already translates a raised constraint into
 * `{ ok: false, reason: "foreign_key" }` — the same refusal reaching the same handler, at no branch
 * cost to the caller. Called before any sweep: a refused withdrawal must change nothing at all.
 */
export function assertAgentOwnsNoGroups(agentId: string): void {
  for (const group of Array.from(groups.values())) {
    if (group.ownerId !== agentId && (group as MixedVersionGroup).founderId !== agentId) continue;
    const error = new Error(
      `update or delete on table "agents" violates foreign key constraint on table "groups"`
    ) as Error & { code: string };
    error.code = "23503";
    throw error;
  }
}

export const posts = globalStore.__safemolt_posts ??= new Map<string, StoredPost>();

export const comments = globalStore.__safemolt_comments ??= new Map<string, StoredComment>();

export const following = globalStore.__safemolt_following ??= new Map<string, Set<string>>();

export const lastPostAt = globalStore.__safemolt_lastPostAt ??= new Map<string, number>();

export const lastCommentAt = globalStore.__safemolt_lastCommentAt ??= new Map<string, number>();

export const commentCountToday = globalStore.__safemolt_commentCountToday ??= new Map<string, { date: string; count: number }>();

export const vettingChallenges = globalStore.__safemolt_vettingChallenges ??= new Map<string, VettingChallenge>();

export const postVotes = globalStore.__safemolt_postVotes ??= new Map<string, StoredPostVote>();

export const commentVotes = globalStore.__safemolt_commentVotes ??= new Map<string, StoredCommentVote>();

export const atprotoIdentitiesByHandle = globalStore.__safemolt_atprotoIdentities ??= new Map<string, AtprotoIdentity>();

export const atprotoBlobs = globalStore.__safemolt_atprotoBlobs ??= new Map<string, AtprotoBlob>();

export const schoolsMap = globalStore.__safemolt_schools ??= new Map<string, StoredSchool>();

export const schoolProfessorsMap = globalStore.__safemolt_schoolProfessors ??= new Map<string, StoredSchoolProfessor>();

export const activityContexts = globalStore.__safemolt_activityContexts ??= new Map<string, StoredActivityContext>();

export const activityEvents = globalStore.__safemolt_activityEvents ??= new Map<string, StoredActivityFeedItem>();

/**
 * M11-2 P2.1 — the memory twin of `activity_events.source_event_id`, keyed like `activityEvents`.
 *
 * A sidecar rather than a field on `StoredActivityFeedItem`, because that type is the public feed
 * shape every reader and every route serializes; the source event id is projection bookkeeping the
 * trail never shows. It exists so the monotonic guard — a late older event may never drag a
 * projection backward — holds in memory mode too, and Jest does not diverge from Postgres on the
 * one property consumption's unorderedness makes load-bearing.
 */
export const activityEventSourceIds = globalStore.__safemolt_activityEventSourceIds ??= new Map<string, number>();

export const notifications = globalStore.__safemolt_notifications ??= new Map<string, StoredNotification>();

/**
 * M11-2 P2.1 — the memory twin of `notifications.dedup_key`'s unique index: key → notification id.
 *
 * A sidecar for the same reason as above: `StoredNotification` is the wire shape the inbox returns,
 * and the dedup key is consumer bookkeeping, not part of the notification. Deleting a notification
 * must clear its key here too — in db mode the key dies with the row, so a memory store that kept
 * it would refuse to re-create a notification Postgres would happily re-create.
 */
export const notificationDedupKeys = globalStore.__safemolt_notificationDedupKeys ??= new Map<string, string>();
export const newsletterSubscribers = globalStore.__safemolt_newsletterSubscribers ??= new Map<string, NewsletterSubscriberRow>();
export const rateWindows = globalStore.__safemolt_rateWindows ??= new Map<string, RateWindowEntry>();
export const playgroundAgentMemories = globalStore.__safemolt_playgroundAgentMemories ??= new Map<string, AgentMemory>();

/**
 * M11-2 u1 — the memory-mode event log: bounded, append-only, ids monotonic.
 *
 * The id counter lives beside the rows in ONE object because the log is capped and drops from the
 * front: deriving the next id from the array would reissue ids after a drop, and ids are what the
 * cursor and receipt machinery compare. Capped so a long-running dev server or a test that emits in
 * a loop cannot grow it without bound (db mode has retention pruning; this is its counterpart).
 */
export const eventLog = globalStore.__safemolt_eventLog ??= { rows: [] as StoredEvent[], nextId: 1 };

/** Oldest-first drop bound for `eventLog.rows`. */
export const EVENT_LOG_CAP = 10_000;

/**
 * M11-2 P3.2 — the memory-mode wakeup queue: `agent_wakeups` rows, keyed by their own id.
 *
 * The id counter lives beside the rows in ONE object, the shape `eventLog` above uses and for a
 * related reason: `agent_wakeups.id` is BIGSERIAL, so it must climb independently of how many rows
 * the map currently holds. Deriving it from `rows.size` would reissue an id as soon as anything was
 * removed, and an id is exactly what `reArmWakeupById` identifies a row by.
 *
 * Uncapped, unlike the event log, and that is not an oversight: the queue is bounded by its own
 * dedup indexes — at most one row per `(agent, reason, event)`, at most one PENDING idle row per
 * `(agent, reason)` — so it cannot grow the way an append-only log can.
 */
export const wakeupQueue = globalStore.__safemolt_wakeups ??= {
  rows: new Map<number, StoredWakeup>(),
  nextId: 1,
};

/**
 * Reset the wakeup queue — **both halves**, which is why it is a helper rather than a line.
 *
 * `resetGroupState`'s reason applies here. A fixture that cleared `rows` alone would leave `nextId`
 * carrying the previous file's high-water mark, so a suite that seeds a row and then asserts on its
 * id — or that computes an id to hand to `reArmWakeupById` — answers differently depending on what
 * ran before it. One helper is the only form of that rule a new fixture cannot get half-right.
 */
export function resetWakeupState(): void {
  wakeupQueue.rows.clear();
  wakeupQueue.nextId = 1;
}

/**
 * M11-2 P3.3 — the memory-mode `agent_loop_state` twin.
 *
 * DB-only until now (`src/lib/agent-loop/state.ts`'s `getLoopState` always called `sql!` directly,
 * and no memory writer of `enabled`/cooldown bookkeeping existed anywhere in the tree — see that
 * file's history and `store/wakeups/memory.ts`'s `resolveWakeupDelivery` note, which named this the
 * chunk that would add one). The runner's claim statement and the execution guard both need a real
 * `enabled` answer per agent in Jest / local no-DB runs, and — matching the db side, where a MISSING
 * row is never claimable (the claim CTE's `EXISTS` fails) — an agent absent from this map is treated
 * as not-enabled by every reader here. `setLoopEnabled`'s memory branch (`agent-loop.ts`) is the only
 * writer of `enabled`; `agent-pulse/runner.ts` is the only writer of the cooldown/action-count fields
 * once the runner replaces `tickAgent`'s own bookkeeping for a wakeup-driven tick.
 *
 * Deliberately NOT wired into `resolveWakeupDelivery` (`wakeups/memory.ts`), which keeps answering
 * `"internal"` unconditionally — see that function's own note. Wiring it there would change
 * ENQUEUE-time behavior for every wave-1 caller (the wakeup-router consumer, the playground deadline
 * sweep) whose existing tests enqueue wakeups without ever seeding a loop-state row; this map is
 * consumed directly by the CLAIM-time and guard-time checks that actually need it instead.
 */
export interface MemoryLoopState {
  agentId: string;
  enabled: boolean;
  lastSeenAt: string | null;
  lastActionAt: string | null;
  nextEligibleAt: string | null;
  lastError: string | null;
  actionsTaken: number;
  errors: number;
}

export const agentLoopState = globalStore.__safemolt_agentLoopState ??= new Map<string, MemoryLoopState>();

export function resetAgentLoopState(): void {
  agentLoopState.clear();
}

/**
 * M11-2 P3.3 — the memory-mode `pulse_budget_counters` twin, keyed `"agentId:day:bucket"`.
 *
 * One flat map rather than a nested one: the db table's primary key is the same triple, and a flat
 * key is what lets `claimNextWakeup`'s memory twin increment-and-check in one synchronous step with
 * no risk of leaving a partially-initialized nested entry behind.
 */
export const pulseBudgetCounters = globalStore.__safemolt_pulseBudgetCounters ??= new Map<string, number>();

export function resetPulseBudgetCounters(): void {
  pulseBudgetCounters.clear();
}

// Imported and re-exported from the one definition both stores share, so a window cannot be raised
// in db mode and left alone in memory mode (M11-1 C16). Imported rather than only re-exported
// because the claim helpers below evaluate them.
import { COMMENT_COOLDOWN_MS, MAX_COMMENTS_PER_DAY, POST_COOLDOWN_MS } from "./rate-limit-windows";

export { POST_COOLDOWN_MS, COMMENT_COOLDOWN_MS, MAX_COMMENTS_PER_DAY };

/**
 * Public entity id. Not a credential (M11-1 C17) — predictability costs nothing here, and these
 * values appear in public payloads anyway. Credentials come from `@/lib/credentials`.
 */
export function generateId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

// ==================== Rate-limit claims (M11-1 C16) ====================
//
// The memory-mode counterparts of the db store's gating statements. Both are **synchronous**, and
// that is the whole guarantee: every `await` yields the event loop, so a limit read in one call and
// stamped in another reproduces exactly the race the db store had — in the mode Jest exercises.
// Read and write here happen in one uninterruptible section, so concurrent callers cannot both pass.
//
// Each returns whether the caller may proceed, and charges the allowance only when it says yes: a
// refusal that re-stamped the window would extend the caller's own cooldown on every retry.

/**
 * Read the post cooldown WITHOUT charging it — the eligibility half of `claimPostAllowance`.
 *
 * It exists so a refusal can be decided before the event preflight runs: in db mode the event insert
 * is gated on the cooldown CTE, so a refused post emits nothing and a duplicate `idem_key` on a
 * retry raises nothing. The claim below stays authoritative — this only ever answers "the claim is
 * about to succeed", and time moving between the two can turn a false into a true and never the
 * reverse, so the pair cannot admit a post the claim would have refused.
 */
export function postAllowanceAvailable(agentId: string): boolean {
  const last = lastPostAt.get(agentId);
  return last === undefined || Date.now() - last >= POST_COOLDOWN_MS;
}

/** Claim one post allowance, or return false if the cooldown refuses it. */
export function claimPostAllowance(agentId: string): boolean {
  const now = Date.now();
  const last = lastPostAt.get(agentId);
  if (last !== undefined && now - last < POST_COOLDOWN_MS) return false;
  lastPostAt.set(agentId, now);
  return true;
}

/**
 * Read the comment cooldown and daily cap WITHOUT charging either — `claimCommentAllowance`'s
 * eligibility half, and `postAllowanceAvailable`'s twin (M11-2 P1.2).
 *
 * Same reason as the post one: the event uniqueness preflight has to run after the mutation is known
 * to be eligible and before it happens, because in db mode the event insert is gated on the claim
 * CTE — a refused comment emits nothing and raises no 23505 there. Time moving between this read and
 * the claim can turn a false into a true and never the reverse, so the pair cannot admit a comment
 * the claim would have refused.
 */
export function commentAllowanceAvailable(agentId: string): boolean {
  const last = lastCommentAt.get(agentId);
  if (last !== undefined && Date.now() - last < COMMENT_COOLDOWN_MS) return false;
  const previous = commentCountToday.get(agentId);
  const today = new Date().toISOString().slice(0, 10);
  return (previous?.date === today ? previous.count : 0) < MAX_COMMENTS_PER_DAY;
}

/** Claim one comment allowance against both the cooldown and the daily cap, or return false. */
export function claimCommentAllowance(agentId: string): boolean {
  const now = Date.now();
  const today = new Date().toISOString().slice(0, 10);
  const last = lastCommentAt.get(agentId);
  const previous = commentCountToday.get(agentId);
  const usedToday = previous?.date === today ? previous.count : 0;

  if (last !== undefined && now - last < COMMENT_COOLDOWN_MS) return false;
  if (usedToday >= MAX_COMMENTS_PER_DAY) return false;

  lastCommentAt.set(agentId, now);
  commentCountToday.set(agentId, { date: today, count: usedToday + 1 });
  return true;
}

// ==================== Vote Tracking Functions ====================

/**
 * Generate a unique key for vote tracking based on agent and target IDs.
 * Used to key votes in the postVotes and commentVotes maps.
 */
export function getVoteKey(agentId: string, targetId: string): string {
  return `${agentId}:${targetId}`;
}

export function memoryIngestWatermarkRef(): { v: string } {
  const g = globalThis as typeof globalThis & { __safemolt_memory_ingest_wm?: { v: string } };
  if (!g.__safemolt_memory_ingest_wm) {
    g.__safemolt_memory_ingest_wm = { v: "1970-01-01T00:00:00.000Z" };
  }
  return g.__safemolt_memory_ingest_wm;
}

// Filter semantics live in ./activity/kinds so the DB store, memory store, and
// activity renderer share one vocabulary. Re-exported for existing importers.
export { normalizeActivityTypeSet, activityFeedIncludes } from "./activity/kinds";
import { normalizeActivityTypeSet, activityFeedIncludes } from "./activity/kinds";

export function activityFeedMatches(item: StoredActivityFeedItem, options: StoredActivityFeedOptions): boolean {
  const beforeTime = options.before ? Date.parse(options.before) : undefined;
  if (beforeTime !== undefined && Number.isFinite(beforeTime)) {
    const itemTime = Date.parse(item.occurredAt);
    if (itemTime > beforeTime) return false;
    if (itemTime === beforeTime && options.beforeId && (item.cursorId ?? item.id) >= options.beforeId) return false;
    if (itemTime === beforeTime && !options.beforeId) return false;
  }
  const sinceTime = options.since ? Date.parse(options.since) : undefined;
  if (sinceTime !== undefined && Number.isFinite(sinceTime)) {
    if (Date.parse(item.occurredAt) <= sinceTime) return false;
  }
  if (options.actorId && item.actorId !== options.actorId) return false;
  if (!activityFeedIncludes(item.kind, normalizeActivityTypeSet(options.types))) return false;
  const q = options.query?.trim().toLowerCase();
  if (!q) return true;
  return [
    item.title,
    item.summary,
    item.contextHint,
    item.searchText,
    JSON.stringify(item.metadata ?? {}),
  ].join(" ").toLowerCase().includes(q);
}

export function memoryAgentNames(agentId?: string): { display: string; canonical: string } {
  if (!agentId) return { display: "Unknown", canonical: "unknown" };
  const agent = agents.get(agentId);
  return {
    display: agent?.displayName?.trim() || agent?.name || agentId,
    canonical: agent?.name || agentId,
  };
}

export function activityContextKey(activityKind: string, activityId: string, promptVersion: string): string {
  return `${activityKind}:${activityId}:${promptVersion}`;
}

/**
 * Remove one trail row, its cached contexts AND its M11-2 source-event watermark.
 *
 * **The sidecars have to die with the row, and this helper exists so no deletion path can forget
 * one.** A stranded `activityEventSourceIds` entry outlives the projection it guarded and then
 * refuses a legitimate re-creation: the monotonic guard compares against a watermark for a row that
 * is not there, so a later event with a lower id writes nothing at all and the trail silently loses
 * an entry. Every memory-mode deleter — post deletion, agent withdrawal, the consumer's own
 * deletion effect — goes through here.
 *
 * Synchronous, so a caller can clear a set of projections with no `await` in the middle.
 */
export function forgetActivityProjection(kind: string, entityId: string): void {
  const key = activityEventKey(kind, entityId);
  activityEvents.delete(key);
  activityEventSourceIds.delete(key);
  const contextPrefix = `${key}:`;
  for (const contextKey of Array.from(activityContexts.keys())) {
    if (contextKey.startsWith(contextPrefix)) activityContexts.delete(contextKey);
  }
}

/**
 * Remove one notification AND the dedup key that points at it.
 *
 * In db mode the key is a column and dies with its row; a memory store that kept it would refuse to
 * re-create a notification Postgres would happily re-create, so a replayed event would diverge
 * between the two modes.
 */
export function forgetNotification(notificationId: string): void {
  notifications.delete(notificationId);
  for (const [key, target] of Array.from(notificationDedupKeys.entries())) {
    if (target === notificationId) notificationDedupKeys.delete(key);
  }
}

export function activityEventKey(kind: string, entityId: string): string {
  return `${kind}:${entityId}`;
}

export function generateChallengeId(): string {
  return `vc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

// ==================== Evaluation Functions ====================

export const evaluationRegistrations = new Map<string, EvaluationRegistration>();

export const evaluationResults = new Map<string, {
  id: string;
  registrationId: string;
  agentId: string;
  evaluationId: string;
  passed: boolean;
  score?: number;
  maxScore?: number;
  pointsEarned?: number;
  resultData?: Record<string, unknown>;
  completedAt: string;
  proctorAgentId?: string;
  proctorFeedback?: string;
  evaluationVersion?: string;
  schoolId?: string;
}>();

export const evaluationSessions = new Map<string, {
  id: string;
  evaluationId: string;
  kind: string;
  registrationId?: string;
  status: string;
  startedAt: string;
  endedAt?: string;
}>();

export const evaluationSessionParticipants = new Map<string, {
  id: string;
  sessionId: string;
  agentId: string;
  role: string;
  joinedAt: string;
}>();

export const evaluationMessages = new Map<string, {
  id: string;
  sessionId: string;
  senderAgentId: string;
  role: string;
  content: string;
  createdAt: string;
  sequence: number;
}>();

export function generateEvaluationId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

// The shared CertificationJob type, not a duplicated inline shape — M11-1 C22 added the judging
// lease fields and the memory store must carry them with db-identical semantics.
export const certificationJobs = new Map<string, CertificationJob>();

// Extend globalThis for HMR persistence
export const pgGlobalStore = globalThis as typeof globalThis & {
  __safemolt_pg_sessions?: Map<string, PlaygroundSession>;
  __safemolt_pg_actions?: Map<string, SessionAction>;
};

export const playgroundSessions = pgGlobalStore.__safemolt_pg_sessions ??= new Map<string, PlaygroundSession>();

export const playgroundActions = pgGlobalStore.__safemolt_pg_actions ??= new Map<string, SessionAction>();

let postIdCounter = 1;
let commentIdCounter = 1;

export function nextPostId(): number {
  return postIdCounter++;
}

export function nextCommentId(): number {
  return commentIdCounter++;
}

export const announcementState: { current: StoredAnnouncement | null } = { current: null };
