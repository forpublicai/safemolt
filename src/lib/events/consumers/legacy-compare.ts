/**
 * M11-2 u4-prep amendment — the shadow soak's comparison, made at DRAIN TIME.
 *
 * **Why here and not in the report's SQL.** The plan's own sentence is normative: production shadow
 * "logs, during a soak …, any key present on one side only *and* any payload mismatch where a shadow
 * key matches a real legacy row". Doing that from SQL days later means comparing a creation-time
 * intent against LIVE legacy state, which collides with every deletion in the window: a
 * right-key/wrong-content row whose subject dies before the operator runs the report is
 * unverifiable, and the machinery that tried to classify those residuals (supersession,
 * expected-key reconstruction, stale-legacy detection) introduced more ambiguity than it removed.
 *
 * At drain time the three things a comparison needs are all in hand — the event, the intended
 * payload, and a legacy row the pipeline committed atomically with the event (Decision 2) seconds
 * earlier. So the verdict is decided once, stamped on the shadow row, and never re-derived.
 *
 * **A comparison failure is DATA, never an outage.** Nothing in this module is allowed to fail a
 * drain: the dispatcher catches everything and stamps `compare_error` with the message, because a
 * consumer whose real effect is still the legacy inline writer must not start dead-lettering events
 * over a diagnostic it only writes to be read by an operator.
 */

/**
 * The stamp vocabulary.
 *
 *  - `matched` — the legacy twin exists at this key and its canonical payload is identical.
 *  - `legacy_missing` — no legacy twin at this key, **or one whose watermark is OLDER than this
 *    event**. Verdict-bearing: a shadow row exists only because `describe` returned an effect, the
 *    twin read re-locks the same subject, and the legacy projection is committed by the statement
 *    that emitted the event — so a row that is absent, or that stopped at an earlier event, means
 *    the inline writer never landed for this one.
 *  - `payload_mismatch` — same key, different content. The differing paths are in `legacy_detail`.
 *  - `superseded` — the legacy row at this key was stamped by a LATER event. **Non-verdict-bearing**,
 *    and routine rather than exceptional: every activity natural key is reusable in place (a
 *    re-follow, a leave-then-rejoin, six playground kinds sharing `playground_session:{id}`), the
 *    inline upsert replaces `source_event_id` on every write, and a drain that runs after the next
 *    write can only ever see the newer row. Diffing this event's intent against it would measure two
 *    different intents; the durable evidence that both writers agreed is the monotonic watermark
 *    itself, which the report's final-state semantics already rest on.
 *  - `unverifiable` — no legacy row can be compared: memory ingest's effect lives in an external
 *    vector provider, a deletion effect's rows are gone by the time the event drains, and a subject
 *    the twin read finds already deleted takes its projections with it (u4prep2 finding 3).
 *  - `compare_error` — the comparison itself threw. Never suppressed, never fatal.
 */
export type LegacyMatch =
  | "matched"
  | "legacy_missing"
  | "payload_mismatch"
  | "superseded"
  | "unverifiable"
  | "compare_error";

/** The vocabulary as data — the soak report's `stamp_vocabulary` is checked against this list. */
export const LEGACY_MATCH_VALUES: readonly LegacyMatch[] = [
  "matched",
  "legacy_missing",
  "payload_mismatch",
  "superseded",
  "unverifiable",
  "compare_error",
];

/**
 * What a consumer's twin reader answers with.
 *
 * `row` carries the legacy projection in the consumer's OWN canonical shape — the same shape
 * `describe` produces, because both sides run through one row→projection mapper in the store. The
 * dispatcher strips the kind's `volatileShadowFields` from this payload with the same list it
 * strips from the shadow payload, so a rename between the two writes cannot read as a mismatch.
 */
export type LegacyTwin =
  | { state: "row"; payload: Record<string, unknown> }
  | { state: "missing"; detail?: Record<string, unknown> }
  | { state: "superseded"; detail?: Record<string, unknown> }
  | { state: "unverifiable"; reason: string };

export interface ShadowStamp {
  legacyMatch: LegacyMatch;
  legacyDetail: Record<string, unknown> | null;
}

/** How many differing paths a mismatch detail carries. A whole-shape divergence is not a novel. */
const MAX_REPORTED_PATHS = 12;

/**
 * The value as JSONB will hold it.
 *
 * The shadow payload is compared against a row that has been through `JSON.stringify` on its way
 * into the column, so the comparison runs on both sides' post-serialization form — otherwise an
 * `undefined` property, or anything with a `toJSON`, would compare as different here and identical
 * in the database.
 */
function asStoredJson(value: unknown): unknown {
  return value === undefined ? undefined : (JSON.parse(JSON.stringify(value)) as unknown);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Every dotted path at which two canonical payloads differ.
 *
 * Recursive through objects so a mismatch names `target.title` rather than the whole row, and
 * **presence-sensitive**: a dropped key differs from a key set to null, which is exactly the
 * failure a containment check (`@>`) would pass vacuously. Arrays are compared whole — the ingest
 * and deletion payloads that carry them stamp `unverifiable` and never reach this.
 */
function collectDifferingPaths(
  shadow: unknown,
  legacy: unknown,
  prefix: string,
  out: string[]
): void {
  if (out.length >= MAX_REPORTED_PATHS) return;
  if (isPlainObject(shadow) && isPlainObject(legacy)) {
    const keys = Array.from(new Set([...Object.keys(shadow), ...Object.keys(legacy)])).sort();
    for (const key of keys) {
      const path = prefix ? `${prefix}.${key}` : key;
      const inShadow = Object.prototype.hasOwnProperty.call(shadow, key);
      const inLegacy = Object.prototype.hasOwnProperty.call(legacy, key);
      if (inShadow !== inLegacy) {
        out.push(path);
        if (out.length >= MAX_REPORTED_PATHS) return;
        continue;
      }
      collectDifferingPaths(shadow[key], legacy[key], path, out);
      if (out.length >= MAX_REPORTED_PATHS) return;
    }
    return;
  }
  if (JSON.stringify(shadow ?? null) !== JSON.stringify(legacy ?? null)) {
    out.push(prefix || "(root)");
  }
}

function valueAtPath(payload: unknown, path: string): unknown {
  if (path === "(root)") return payload;
  let cursor: unknown = payload;
  for (const segment of path.split(".")) {
    if (!isPlainObject(cursor)) return undefined;
    cursor = cursor[segment];
  }
  return cursor;
}

/**
 * The verdict for one shadow effect, from its twin.
 *
 * Pure and store-agnostic on purpose: the db drain and the memory dispatcher both reach it, and it
 * is the one place the vocabulary is decided.
 */
export function stampShadowComparison(
  twin: LegacyTwin,
  canonicalShadowPayload: Record<string, unknown>
): ShadowStamp {
  if (twin.state === "unverifiable") {
    return { legacyMatch: "unverifiable", legacyDetail: { reason: twin.reason } };
  }
  if (twin.state === "superseded") {
    return { legacyMatch: "superseded", legacyDetail: twin.detail ?? null };
  }
  if (twin.state === "missing") {
    return { legacyMatch: "legacy_missing", legacyDetail: twin.detail ?? null };
  }

  const shadow = asStoredJson(canonicalShadowPayload);
  const legacy = asStoredJson(twin.payload);
  const paths: string[] = [];
  collectDifferingPaths(shadow, legacy, "", paths);
  if (paths.length === 0) return { legacyMatch: "matched", legacyDetail: null };

  return {
    legacyMatch: "payload_mismatch",
    legacyDetail: {
      paths,
      // Both sides, per differing path — the operator needs to see WHICH writer is wrong, and the
      // report no longer carries whole canonicalized payloads to compare by eye.
      differences: paths.map((path) => ({
        path,
        shadow: valueAtPath(shadow, path) ?? null,
        legacy: valueAtPath(legacy, path) ?? null,
      })),
    },
  };
}

/** The message a thrown comparison stamps. Bounded: `legacy_detail` is a diagnostic, not a log. */
export function compareErrorStamp(error: unknown): ShadowStamp {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return { legacyMatch: "compare_error", legacyDetail: { message: message.slice(0, 1000) } };
}
