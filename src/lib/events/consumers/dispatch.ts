/**
 * M11-2 P2.1 — the one dispatcher every consumer is built from.
 *
 * A consumer is a coverage manifest plus an effects implementation; this turns the pair into the
 * `handleEvent` the drain machinery drives. Everything the drain already owns stays there —
 * receipts on success, skipping kinds this build does not know, the retry ledger, dead letters — so
 * this file does exactly four things, one per coverage state, and nothing else.
 *
 * **Throwing is the correct failure mode here.** The public `record*ActivityEvent` wrappers catch
 * and log every DB failure (best-effort by design for the inline call sites), which would let a
 * consumer advance past a failed projection and blind the retry/dead-letter machinery entirely. So
 * the consumer calls the underlying throwing form and failures propagate (P2.1). Throw
 * `PermanentEffectError` only for a contract error a retry can never fix — a malformed payload, a
 * reference that cannot ever resolve.
 */
import { hasDatabase } from "@/lib/db";
import type { EventConsumerDescriptor } from "@/lib/store/events";
import { recordConsumerShadowEffects, type ShadowEffectRow } from "@/lib/store";
import type { StoredEvent } from "@/lib/store-types";

import { PermanentEffectError } from "../errors";
import { STORE_ASSIGNED_PAYLOAD_ID } from "../kinds";
import type { CoverageManifest, CoverageState } from "./coverage";
import {
  compareErrorStamp,
  stampShadowComparison,
  type LegacyTwin,
  type ShadowStamp,
} from "./legacy-compare";

/**
 * One intended effect, as a shadow soak compares it: the consumer's own natural key plus the
 * canonical content it would have written.
 *
 * The key is what makes comparison well-defined (notification `dedup_key`, activity upsert key,
 * recipient-scoped ingest chunk key); the payload is what stops a right-key/wrong-content consumer
 * from passing verification. Generated ids and timestamps are excluded by construction — a payload
 * that carried them would differ on every run and make every key a mismatch.
 */
export interface ShadowEffect {
  key: string;
  payload: Record<string, unknown>;
}

/**
 * A consumer's effects for one kind set.
 *
 * Two operations, deliberately, rather than a plan-then-apply pair of one: memory ingest's unit of
 * *effect* is a recipient (one durable progress row) while its unit of *comparison* is a chunk
 * (`{recipient}:{chunk_id}`), so a single enumeration cannot serve both. Implementations share
 * their computation through internal helpers instead; `describe` and `apply` disagreeing is what
 * the shadow soak exists to catch, and the seeded suite runs both.
 */
export interface ConsumerEffects {
  /** What this consumer WOULD write. Writes no projection. Empty means "nothing to do". */
  describe(event: StoredEvent): Promise<ShadowEffect[]>;
  /** The real projection write. Throws on failure; the drain's ledger is the handler. */
  apply(event: StoredEvent): Promise<void>;
  /**
   * Payload paths this consumer's shadow rows must NOT carry, per kind.
   *
   * **Volatile presentation fields, excluded from the canonical payload by design.** Both writers
   * derive an actor's display name, canonical name and name-built href from LIVE agent state, and
   * the two writes happen at different instants: the legacy inline writer at mutation time, the
   * consumer when the event drains. An agent who renames — or withdraws, falling back to a raw id —
   * in between makes both sides correct and the diff a mismatch, on every one of that agent's
   * events, for as long as the soak runs. Comparing them would measure the clock rather than the
   * cutover.
   *
   * So the soak compares STRUCTURE — ids, types, metadata ids, titles captured from content, dedup
   * keys — and excludes the rest by an explicit per-kind list that lives beside `describe`. This is
   * the same class of accepted consume-time drift as P2.1's ingest audience recomputation: a
   * projection reflects the world at the moment it is written, and the pipeline is deliberately
   * asynchronous. A path may be nested (`actor.name`).
   *
   * The SAME list is applied to the legacy twin before the two are diffed (`readLegacyTwin`), so an
   * excluded field cannot be a mismatch on either side.
   */
  volatileShadowFields?: Readonly<Record<string, readonly string[]>>;
  /**
   * The LEGACY row this effect would have duplicated, for the drain-time comparison (u4-prep).
   *
   * Called once per described effect, immediately before the shadow row is written — which is the
   * whole point of the amendment: the legacy projection is committed atomically with the event
   * (Decision 2), so at drain time it either exists or has been deleted since, and a comparison made
   * here needs no reconstruction of what the key "should" have been. The payload comes back in the
   * consumer's own canonical shape; the dispatcher strips this kind's `volatileShadowFields` from it
   * with the same list it strips from the shadow payload.
   *
   * Optional, and its ABSENCE is data rather than a crash: a consumer with no twin reader stamps
   * `unverifiable` with a reason, so a future consumer that forgets one appears in the report
   * instead of silently reading as clean.
   */
  readLegacyTwin?(event: StoredEvent, effectKey: string): Promise<LegacyTwin>;
}

/** Drop one dotted path from a payload copy. Missing intermediate objects are simply left alone. */
function omitPath(payload: Record<string, unknown>, path: string): Record<string, unknown> {
  const [head, ...rest] = path.split(".");
  if (!(head in payload)) return payload;
  if (rest.length === 0) {
    const { [head]: _dropped, ...remaining } = payload;
    return remaining;
  }
  const nested = payload[head];
  if (!nested || typeof nested !== "object" || Array.isArray(nested)) return payload;
  return { ...payload, [head]: omitPath(nested as Record<string, unknown>, rest.join(".")) };
}

/** The canonical payload a shadow row records: the described one, minus the volatile paths. */
function normalizeShadowPayload(
  payload: Record<string, unknown>,
  paths: readonly string[]
): Record<string, unknown> {
  return paths.reduce(omitPath, payload);
}

/**
 * The drain-time verdict for ONE described effect (u4-prep).
 *
 * **It cannot fail the drain, and that is the contract this function exists to hold.** In `shadow`
 * the real effect still belongs to the legacy inline writer, so a consumer that started throwing
 * over a comparison would burn its retry attempts and dead-letter events whose projections were
 * fine. Every failure — a missing reader, a thrown query, a malformed twin — becomes a stamped
 * value somebody can read in the report.
 */
async function compareToLegacyTwin(
  effects: ConsumerEffects,
  event: StoredEvent,
  effectKey: string,
  canonicalShadowPayload: Record<string, unknown>,
  volatilePaths: readonly string[]
): Promise<ShadowStamp> {
  try {
    if (!effects.readLegacyTwin) {
      return {
        legacyMatch: "unverifiable",
        legacyDetail: { reason: "this consumer declares no legacy twin reader" },
      };
    }
    const twin = await effects.readLegacyTwin(event, effectKey);
    // The SAME exclusion list, applied to both sides. Stripping only the shadow payload would make
    // every volatile field a mismatch, which is the exact measurement the list exists to avoid.
    const compared: LegacyTwin =
      twin.state === "row" && volatilePaths.length > 0
        ? { state: "row", payload: normalizeShadowPayload(twin.payload, volatilePaths) }
        : twin;
    return stampShadowComparison(compared, canonicalShadowPayload);
  } catch (error) {
    return compareErrorStamp(error);
  }
}

/**
 * How the memory-mode dispatcher delivers this consumer (Decision 6).
 *
 *  - `await` — the projection must be visible when the emitting store call resolves. That is what
 *    today's inline notification and activity writes provide, and what the M8 memory-store
 *    invariant requires: Jest observes the projection immediately after the store call returns.
 *  - `background` — scheduled on a non-throwing floating promise. Memory ingest is deliberately
 *    fire-and-forget today (`waitUntil` at the post and comment routes) with sequential awaited
 *    vector work for up to 2,000 recipients, so awaiting it inline would turn a local no-DB post
 *    into a minutes-long call dependent on external vector availability.
 *
 * Ignored in db mode, where the drain is the only driver.
 */
export type MemoryModeDelivery = "await" | "background";

/**
 * A consumer as the registry holds it: the drain's descriptor plus the two facts only the
 * in-process memory dispatcher and the contract hash need.
 *
 * It extends `EventConsumerDescriptor` rather than changing it, so `drain-db.ts` — hardened by its
 * own review round — is consumed as-is and a `RegisteredConsumer[]` is still an
 * `EventConsumerDescriptor[]` everywhere the drain route passes one.
 */
export interface RegisteredConsumer extends EventConsumerDescriptor {
  coverage: CoverageManifest;
  memoryModeDelivery: MemoryModeDelivery;
}

function coverageFor(coverage: CoverageManifest, kind: string): CoverageState {
  const state = (coverage as Record<string, CoverageState | undefined>)[kind];
  if (state) return state;
  // Unreachable by construction: a kind enters the union in the same deploy that gives every
  // consumer its entry, `satisfies Record<EventKind, CoverageState>` makes an omission a compile
  // error, and the manifest test re-asserts it at runtime. If it ever happens anyway, retrying
  // cannot fix a missing manifest entry, so dead-letter it loudly rather than spin three attempts.
  throw new PermanentEffectError(`[events] no coverage entry for kind '${kind}'`);
}

/**
 * Build the drain-facing consumer from a manifest and an effects implementation.
 *
 * `legacy` and `none` are both no-ops and are deliberately NOT collapsed into one branch: they mean
 * different things (one defers to a declared inline writer, one is history-only by policy), and the
 * manifest test enforces different rules for each.
 */
export function defineConsumer(options: {
  name: string;
  coverage: CoverageManifest;
  effects: ConsumerEffects;
  memoryModeDelivery: MemoryModeDelivery;
}): RegisteredConsumer {
  const { name, coverage, effects } = options;

  return {
    name,
    coverage,
    memoryModeDelivery: options.memoryModeDelivery,
    async handleEvent(event: StoredEvent): Promise<void> {
      switch (coverageFor(coverage, event.kind)) {
        case "legacy":
          // That kind's declared inline writer still owns the projection. Receipt, no effect.
          return;
        case "none":
          // History-only by policy. Receipted deliberately: unreceipted it would wedge this
          // consumer's scan floor at that id forever.
          return;
        case "shadow": {
          // **No DB, no shadow soak — so `shadow` behaves as `legacy` in memory mode.** The
          // comparison rows live in `event_consumer_shadow`, and the whole point of the soak is to
          // diff them against the legacy inline writer's real output in production. Memory mode has
          // neither table nor soak, and the legacy writer is still the only real writer there too,
          // so doing nothing is the same behavior a db-mode `shadow` produces.
          //
          // The COMPARISON below is nonetheless store-agnostic — `readLegacyTwin` resolves through
          // the store facade and every twin reader has a memory implementation — so the stamping
          // logic is exercised in memory mode by its unit gate rather than being db-only code that
          // only production ever runs.
          if (!hasDatabase()) return;
          const described = await effects.describe(event);
          if (described.length === 0) return;
          const volatilePaths = effects.volatileShadowFields?.[event.kind] ?? [];
          // Sequential, and cheaply so: the two comparable consumers describe ONE effect per event,
          // and the fan-out shapes (ingest recipients, a deletion's comment ids) answer
          // `unverifiable` without touching the database at all.
          const effectRows: ShadowEffectRow[] = [];
          for (const effect of described) {
            const payload =
              volatilePaths.length === 0
                ? effect.payload
                : normalizeShadowPayload(effect.payload, volatilePaths);
            const stamp = await compareToLegacyTwin(
              effects,
              event,
              effect.key,
              payload,
              volatilePaths
            );
            effectRows.push({ key: effect.key, payload, ...stamp });
          }
          await recordConsumerShadowEffects(name, event.id, effectRows);
          return;
        }
        case "on":
          await effects.apply(event);
          return;
      }
    },
  };
}

/**
 * The event's payload as a plain object, or a dead letter.
 *
 * Payloads arrive from JSONB written by a possibly-newer producer, so nothing about their shape is
 * guaranteed by the compiler at this boundary. A payload that is not an object is a malformed
 * contract, which is exactly what `PermanentEffectError` is for: no retry can repair it. The field
 * accessors below narrow the rest, one required field at a time, for the same reason.
 */
export function eventPayload(event: StoredEvent): Record<string, unknown> {
  const payload = event.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new PermanentEffectError(`[events] event ${event.id} (${event.kind}) has no object payload`);
  }
  return payload as Record<string, unknown>;
}

/**
 * Is this a usable id, or one of the two forms that mean "nobody filled this in"?
 *
 * The empty string addresses nothing. `STORE_ASSIGNED_PAYLOAD_ID` is the placeholder an action
 * writes for a value its store is supposed to supply — if it survives to consume time, the store's
 * merge did not run or did not cover the field, and treating it as an id would key every projection
 * off a subject that does not exist.
 */
function isUsableId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value !== STORE_ASSIGNED_PAYLOAD_ID;
}

/** A required string id from a payload, refused loudly rather than coerced. */
export function payloadId(event: StoredEvent, payload: Record<string, unknown>, field: string): string {
  const value = payload[field];
  if (!isUsableId(value)) {
    throw new PermanentEffectError(
      `[events] event ${event.id} (${event.kind}) payload '${field}' is not a non-empty string, ` +
        `or is still the store-assigned placeholder`
    );
  }
  return value;
}

/**
 * A **required-nullable** id: the field must be PRESENT, and either `null` or a non-empty string.
 *
 * The distinction is load-bearing, not pedantry. `comment.created.parent_id` is `string | null`, and
 * `null` is a meaningful value — it means "top level", which routes the notification to the POST's
 * author rather than to a parent commenter. Treating a missing or empty field as `null` would take a
 * malformed reply event and quietly notify the wrong agent, forever, with no error anywhere. A
 * payload that does not carry the field is a contract error, and no retry can repair one.
 */
export function requiredNullablePayloadId(
  event: StoredEvent,
  payload: Record<string, unknown>,
  field: string
): string | null {
  if (!Object.prototype.hasOwnProperty.call(payload, field)) {
    throw new PermanentEffectError(
      `[events] event ${event.id} (${event.kind}) payload is missing '${field}'`
    );
  }
  const value = payload[field];
  if (value === null) return null;
  // The store-assigned placeholder is refused here too. No kind uses it for a nullable field today,
  // and the point is that it stays that way: a `null`-tolerant accessor is exactly where an unfilled
  // marker would be easiest to mistake for a deliberate absence.
  if (!isUsableId(value)) {
    throw new PermanentEffectError(
      `[events] event ${event.id} (${event.kind}) payload '${field}' is not null or a non-empty ` +
        `string, or is still the store-assigned placeholder`
    );
  }
  return value;
}

/**
 * A required string-array payload field (`post.deleted`'s three id lists).
 *
 * Empty strings are refused rather than passed through: an empty agent id addresses nobody, and it
 * would silently become a cleanup that skips a recipient whose vectors then survive forever.
 *
 * **`STORE_ASSIGNED_PAYLOAD_ID` is refused for the same reason and a stronger one.** These lists are
 * filled by the store, not by the action that decided the event, and the failure mode of a missed
 * merge is invisible: an empty array is a perfectly valid audience, so an unfilled field would be a
 * cleanup that quietly reaches nobody, receipted and never revisited. The action therefore seeds each
 * list with the placeholder, a whole-array replacement is the only thing that clears it, and a
 * survivor dead-letters here.
 */
export function payloadIdList(
  event: StoredEvent,
  payload: Record<string, unknown>,
  field: string
): string[] {
  const value = payload[field];
  if (!Array.isArray(value) || value.some((entry) => !isUsableId(entry))) {
    throw new PermanentEffectError(
      `[events] event ${event.id} (${event.kind}) payload '${field}' is not an array of non-empty ` +
        `strings, or still holds the store-assigned placeholder`
    );
  }
  return value as string[];
}

/**
 * A re-fetched subject must AGREE with the payload that named it, or the event is malformed.
 *
 * **Existence is not correlation, and the gap between them is exploitable.** A consumer re-fetches
 * by one id and then trusts every other id in the payload: an event naming comment `C` with
 * `post_id = P'` would, if `C` actually lives on `P`, ingest `C` under `P'`'s title to `P'`'s
 * audience, or notify `P'`'s author about a comment on somebody else's post. The subject is live,
 * every read succeeds, and nothing anywhere raises.
 *
 * No retry can reconcile two ids that disagree, so this dead-letters rather than skipping: a skip
 * would receipt the event silently, and a silently-swallowed malformed event is exactly what the
 * dead-letter ledger exists to make visible.
 */
export function requireCorrelation(
  event: StoredEvent,
  field: string,
  fromPayload: unknown,
  fromSubject: unknown
): void {
  if (fromPayload === fromSubject) return;
  throw new PermanentEffectError(
    `[events] event ${event.id} (${event.kind}) payload '${field}' is ${JSON.stringify(fromPayload)} ` +
      `but the re-fetched subject says ${JSON.stringify(fromSubject)}`
  );
}

/** A required subject/actor COLUMN — follows carry both agents there rather than in the payload. */
export function requireColumn(event: StoredEvent, column: "actorAgentId" | "subjectId"): string {
  const value = event[column];
  if (typeof value !== "string" || value.length === 0) {
    throw new PermanentEffectError(
      `[events] event ${event.id} (${event.kind}) has no ${column}`
    );
  }
  return value;
}
