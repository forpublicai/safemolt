/**
 * M11-2 P1.0 — the Decision-2 renderer: a prepared event as a SQL fragment gated on the decisive
 * mutation's own CTE.
 *
 * **Why a fragment and not a second statement.** On the Neon HTTP driver every `sql``` call
 * auto-commits, and a `sql.transaction` batch is a fixed array of independent queries — a later
 * element cannot read an earlier element's `RETURNING`. So a free-standing event insert placed
 * beside a mutation is atomic at commit yet still emits a **ghost event** whenever a concurrent
 * racer turns the mutation into a no-op. Events are authoritative history feeding notifications and
 * wakeups, so both directions must hold: no write without its event, no event without its write.
 * The only shape that gives that is one statement in which the insert reads the decisive mutation's
 * rows.
 *
 * This module is a pure renderer with no driver dependency, which is why it is not a `pickStore`
 * pair: memory mode never renders SQL, and a memory twin of a string builder would be a second
 * source of truth for the column list.
 */
import { isKnownEventKind, type PreparedEvent } from "@/lib/events/kinds";

/** A SQL fragment plus the parameters its placeholders consume, in order. */
export interface EventStatementFragment {
  /** SQL text using `$n` placeholders, starting at the caller's `firstParamIndex`. */
  text: string;
  /** Values for those placeholders. The caller appends them after its own parameters. */
  params: unknown[];
}

export interface EventStatementOptions {
  /**
   * 1-based index of the first placeholder **this fragment** emits. Rendering only.
   *
   * When several events are rendered against one statement it moves with each of them, because each
   * one's placeholders continue where the previous one's stopped. It is therefore NOT the boundary a
   * `sqlParam` reference is checked against — see `callerParamBoundary`.
   */
  firstParamIndex?: number;
  /**
   * 1-based index where the CALLER's own parameters stop. Validation only, and **fixed** across
   * every event rendered against one statement.
   *
   * The two are the same number for a single event and diverge the moment there are two, which is
   * exactly where using one for both goes wrong: the second event's `firstParamIndex` sits *above*
   * the first event's placeholders, so a `sqlParam` pointing into them would pass a check made
   * against it — silently reading a **prior event's bound value** while the API promises the
   * caller's own parameter space. `emitEventCtes` pins this and lets `firstParamIndex` move — to its
   * own start by default, and to the boundary a COMPOSED caller supplies (see
   * `EmitEventCtesOptions.callerParamBoundary`), because a second render's start is above the first
   * render's placeholders in exactly the same way.
   *
   * Defaults to `firstParamIndex` (the single-fragment case, where they coincide).
   */
  callerParamBoundary?: number;
  /**
   * SQL replacing a subject column's parameter, for a value **only the executing statement knows**.
   *
   * u2 left this shape deliberately unbuilt and named the chunk that would need it: "derived events
   * whose subjects vary PER ROW need column substitution from the CTE, not a constant repeated N
   * times — that shape arrives with the prepared-events store parameter in u3". u3 needs the
   * narrower half of it: `createPost` mints the post id inside the store, *after* the action decided
   * the event, so `subject_id` cannot be a constant the action supplied.
   *
   * Values are built by `sqlParam` / `sqlColumn` and by nothing else — see `EventValueSql`. The
   * overridden column's parameter is **not** emitted, because this driver refuses a bind with more
   * parameters than the statement references.
   */
  columnSql?: Partial<Record<EventSubjectColumn, EventValueSql>>;
  /**
   * The CTE this fragment selects `FROM` — **one event per row of it**.
   *
   * Without it the insert's `SELECT` has no row source at all, so it emits exactly one event built
   * from constants, and a `sqlColumn` value has nothing to resolve against: the rendered SQL would
   * raise `42P01`/`42703` on its first execution. That is the whole reason this option exists rather
   * than the column vocabulary quietly advertising a shape the renderer could not produce.
   *
   * With it, the fragment is P1.2's derived-event shape: a comment's mention fan-out selects from a
   * `mentions` CTE and emits one `agent.mentioned` per target, each carrying its own subject. Every
   * `sqlColumn` qualifier must name this CTE — a reference to any other relation has no `FROM` entry
   * and is refused where it is written rather than at 42P01 time.
   *
   * The gate is unchanged: the insert still carries `WHERE EXISTS (SELECT 1 FROM <decisiveCte>)`, so
   * a decisive mutation raced to zero rows emits nothing however many rows the row source holds.
   */
  rowSource?: string;
  /**
   * A JSONB object merged **over** the prepared payload (`prepared || merge`, so the SQL wins).
   *
   * The one payload the action cannot fully decide is `post.deleted`'s: its comment ids, commenter
   * ids and audience are only knowable inside the batch element that holds the thread lock, and a
   * pre-read of them is the TOCTOU gap M11-1b D1 finding 5 closed. The action still decides the
   * event — kind, actor, subject, and the ids it already holds — and the statement fills what only
   * it can see. Built by `sqlPayloadObject` and by nothing else.
   */
  payloadMergeSql?: PayloadObjectSql;
}

// ---------------------------------------------------------------------------
// The closed value vocabulary
//
// `emitEventStatement` is an EXPORTED renderer that splices these fragments into SQL, and SQL
// fragments cannot be parameterized. An option typed `string` is therefore an open interpolation
// surface on a public function: correct for every caller in the tree today, and one careless
// `${something}` away from injection tomorrow.
//
// So the options take **opaque descriptions, never SQL text**. A constructor validates its inputs
// and returns a frozen object carrying a module-private symbol; the renderer accepts nothing else
// and **re-validates every field at render time**. Both halves are load-bearing and for different
// attackers: the symbol stops a plain object (a JavaScript caller with no types, a JSON payload
// that reached this far) from being mistaken for a constructed value, and the re-validation stops
// a forged object that somehow carries the symbol — reached through `Object.getOwnPropertySymbols`
// on a real value — from carrying a hostile identifier. Nothing here ever renders a string it did
// not build itself from a field it just checked.
//
// Adding a shape means adding a constructor AND a render arm, in a reviewed diff, next to the
// validation. There is deliberately no escape hatch.
// ---------------------------------------------------------------------------

/**
 * The brand. Module-private, so a value from anywhere else cannot claim to be one of ours — and
 * `Symbol()` rather than `Symbol.for()`, because a registered symbol is retrievable by name.
 */
const EVENT_VALUE_BRAND = Symbol("safemolt.events.valueSql");

/** A scalar SQL value expression, as a DESCRIPTION. Never SQL text, and never a plain string. */
export type EventValueSql = {
  readonly [EVENT_VALUE_BRAND]: true;
} & (
  | { readonly form: "param"; readonly index: number; readonly cast: string | null }
  | { readonly form: "column"; readonly ref: string; readonly cast: string | null }
  | {
      readonly form: "json_agg";
      readonly cte: string;
      readonly column: string;
      readonly orderBy: string;
      readonly distinct: boolean;
    }
);

/** A JSONB object expression, as a description. */
export type PayloadObjectSql = {
  readonly [EVENT_VALUE_BRAND]: true;
  readonly form: "payload_object";
  readonly entries: ReadonlyArray<readonly [string, EventValueSql]>;
};

/** A bare SQL identifier. Nothing else — no spaces, no operators, no quotes. */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** An identifier, or a `table.column` pair. */
const COLUMN_REF = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/;

function requireShape(value: unknown, shape: RegExp, what: string): string {
  if (typeof value !== "string" || !shape.test(value)) {
    throw new Error(`[events] ${what} ${JSON.stringify(value)} is not a usable SQL identifier`);
  }
  return value;
}

function requireIndex(value: unknown, what: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`[events] ${what} must be a positive integer, received ${String(value)}`);
  }
  return value as number;
}

/** Freeze what the constructors hand back: a caller cannot edit a validated value after the fact. */
function brand<T extends object>(value: T): T & { readonly [EVENT_VALUE_BRAND]: true } {
  return Object.freeze({ ...value, [EVENT_VALUE_BRAND]: true as const });
}

/**
 * One of the CALLER's own placeholders, by index — `sqlParam(1, "text")` renders `$1::text`.
 *
 * This is how `createPost` puts the id it just minted into `subject_id` and into the payload: the
 * value is still a bound parameter, so nothing about it is interpolated except its number.
 *
 * **The index is checked twice**, and the second check is the one that matters. Here it is only
 * "a positive integer", because a constructor cannot know where the caller's parameter space ends.
 * At render time it is bounded against `firstParamIndex`: a reference at or above that points into
 * this fragment's own placeholders — or past the end of the statement entirely — and would silently
 * read somebody else's value or fail as an opaque bind error.
 */
export function sqlParam(index: number, cast?: string): EventValueSql {
  return brand({
    form: "param" as const,
    index: requireIndex(index, "sqlParam index"),
    cast: cast === undefined ? null : requireShape(cast, IDENTIFIER, "cast"),
  });
}

/**
 * A column of the fragment's **row source** — `sqlColumn("mentions.agent_id")`, or bare `agent_id`.
 *
 * It is only usable together with `rowSource`, and the renderer enforces that: without one the
 * insert's `SELECT` has no `FROM`, so any column reference is a `42P01`/`42703` waiting for its first
 * execution. That pairing is the second half of the vocabulary u2 named ("column substitution from
 * the CTE"), and it is the form P1.2's derived `agent.mentioned` events need — one statement, one
 * event per mention target, each with its own subject.
 *
 * **No u3 caller.** u3's own substitutions are all `sqlParam`, because a post has exactly one event.
 */
export function sqlColumn(ref: string, cast?: string): EventValueSql {
  return brand({
    form: "column" as const,
    ref: requireShape(ref, COLUMN_REF, "column reference"),
    cast: cast === undefined ? null : requireShape(cast, IDENTIFIER, "cast"),
  });
}

/**
 * Every id in one column of one CTE, as a JSON array — **deterministically ordered**.
 *
 * Order is not decoration here: the shadow soak diffs canonical payloads, and the memory store
 * builds the same lists with `Array.prototype.sort`. `jsonb_agg` without an `ORDER BY` returns rows
 * in whatever order the plan produced them, and `jsonb_agg(DISTINCT x)` is no better — the
 * deduplication does not promise an output order. So the distinct form aggregates over an explicitly
 * ordered `SELECT DISTINCT` subquery rather than relying on the aggregate.
 *
 * `COALESCE(…, '[]')` is what makes an empty CTE render an empty array rather than SQL NULL, which
 * `payloadIdList` would refuse.
 */
export function sqlJsonAgg(options: {
  /** The CTE to read. */
  cte: string;
  /** The column to collect. */
  column: string;
  /** The column to order by. Defaults to `column`. */
  orderBy?: string;
  /** Deduplicate first. The order is then the collected column's own. */
  distinct?: boolean;
}): EventValueSql {
  const column = requireShape(options.column, IDENTIFIER, "column");
  return brand({
    form: "json_agg" as const,
    cte: requireShape(options.cte, IDENTIFIER, "CTE name"),
    column,
    orderBy: requireShape(options.orderBy ?? column, IDENTIFIER, "order column"),
    distinct: options.distinct === true,
  });
}

/** A `jsonb_build_object` over validated keys and constructed values. The only merge shape there is. */
export function sqlPayloadObject(entries: Record<string, EventValueSql>): PayloadObjectSql {
  const pairs = Object.entries(entries);
  if (pairs.length === 0) throw new Error("[events] sqlPayloadObject needs at least one entry");
  return brand({
    form: "payload_object" as const,
    entries: pairs.map(
      ([key, value]) =>
        // The key is validated even though it renders as a quoted literal: a key carrying a quote
        // would close the literal. The value is validated by being branded — `renderValue` re-checks
        // it anyway.
        [requireShape(key, IDENTIFIER, "payload key"), requireBranded(value, `payload key '${key}'`)] as const
    ),
  });
}

/** Where a rendered value may point, so a `$n` or a column reference can be bounded. */
interface RenderScope {
  /**
   * 1-based index where the CALLER's own parameters stop — the validation boundary, fixed across
   * every event of one statement. Deliberately NOT this fragment's own start: see
   * `EventStatementOptions.callerParamBoundary`.
   */
  callerParamBoundary: number;
  /** The CTE this fragment selects `FROM`, or null when its `SELECT` has no row source. */
  rowSource: string | null;
}

function requireBranded<T>(value: T, where: string): T {
  const candidate = value as unknown as Record<symbol, unknown> | null;
  if (!candidate || typeof candidate !== "object" || candidate[EVENT_VALUE_BRAND] !== true) {
    throw new Error(`[events] ${where} was not built by this module's SQL value constructors`);
  }
  return value;
}

/** `::type`, re-validated. A cast is the easiest place to smuggle an expression. */
function renderCast(cast: unknown, where: string): string {
  return cast === null || cast === undefined ? "" : `::${requireShape(cast, IDENTIFIER, `${where} cast`)}`;
}

/**
 * Render one description as SQL, **re-validating every field**.
 *
 * A constructed value has already been checked. This checks again because the type system is not the
 * boundary: an untyped caller, or a forged object carrying a symbol lifted off a real value, reaches
 * exactly here. Rendering is the last place the check can still matter, so it happens here.
 */
function renderValue(value: unknown, scope: RenderScope, where: string): string {
  const described = requireBranded(value, where) as EventValueSql;
  switch (described.form) {
    case "param": {
      const index = requireIndex(described.index, `${where} parameter index`);
      // The caller's own parameters occupy 1..callerParamBoundary-1; everything from there up is a
      // rendered EVENT's placeholders — this fragment's, or an earlier event's in the same statement
      // — or past the end of the statement entirely. A reference into that range reads a value the
      // caller never offered, and the prior-event case is the one that would otherwise bind
      // silently: it is a real `$n` holding somebody else's event column.
      if (index >= scope.callerParamBoundary) {
        throw new Error(
          `[events] ${where} references $${index}, which is not one of the caller's own parameters ` +
            `(they end at $${scope.callerParamBoundary - 1})`
        );
      }
      return `$${index}${renderCast(described.cast, where)}`;
    }
    case "column": {
      const ref = requireShape(described.ref, COLUMN_REF, `${where} column reference`);
      // **A column needs a row source, and the renderer is where that is knowable.** Without one the
      // SELECT has no FROM at all, so this would be a `42703`/`42P01` on first execution rather than
      // a caught mistake — the exact failure a constructor-time check cannot see, because a
      // constructor does not know what statement it will be spliced into.
      if (!scope.rowSource) {
        throw new Error(
          `[events] ${where} references column '${ref}', but this fragment selects FROM no row ` +
            `source — supply 'rowSource' (the per-row derived-event shape)`
        );
      }
      const [qualifier] = ref.includes(".") ? ref.split(".") : [null];
      if (qualifier !== null && qualifier !== scope.rowSource) {
        throw new Error(
          `[events] ${where} references '${ref}', but this fragment selects FROM ` +
            `'${scope.rowSource}' — a qualifier naming any other relation has no FROM entry`
        );
      }
      return `${ref}${renderCast(described.cast, where)}`;
    }
    case "json_agg": {
      const cte = requireShape(described.cte, IDENTIFIER, `${where} CTE name`);
      const column = requireShape(described.column, IDENTIFIER, `${where} column`);
      if (described.distinct === true) {
        return `(SELECT COALESCE(jsonb_agg(src.${column} ORDER BY src.${column}), '[]'::jsonb)
              FROM (SELECT DISTINCT ${column} FROM ${cte}) src)`;
      }
      const orderBy = requireShape(described.orderBy, IDENTIFIER, `${where} order column`);
      return `(SELECT COALESCE(jsonb_agg(src.${column} ORDER BY src.${orderBy}), '[]'::jsonb)
            FROM ${cte} src)`;
    }
    default:
      throw new Error(`[events] ${where} has an unknown value form`);
  }
}

/** Render a payload merge object, re-validating its keys and every value. */
function renderPayloadObject(value: unknown, scope: RenderScope): string {
  const described = requireBranded(value, "payloadMergeSql") as PayloadObjectSql;
  if (described.form !== "payload_object" || !Array.isArray(described.entries) || described.entries.length === 0) {
    throw new Error("[events] payloadMergeSql is not a usable payload object");
  }
  const rendered = described.entries.map((entry) => {
    const [key, entryValue] = entry as readonly [string, EventValueSql];
    const safeKey = requireShape(key, IDENTIFIER, "payload key");
    return `'${safeKey}', ${renderValue(entryValue, scope, `payload key '${safeKey}'`)}`;
  });
  return `jsonb_build_object(${rendered.join(", ")})`;
}

/**
 * A CTE name is an IDENTIFIER: it cannot be parameterized, so it is interpolated into SQL text.
 * Callers are in-repo and pass literals, but "in-repo today" is not a property this function can
 * check later, so the shape is enforced rather than trusted.
 */
const CTE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Column order is fixed here and nowhere else; every writer of `events` renders through it. */
const EVENT_COLUMNS = [
  "kind",
  "actor_agent_id",
  "subject_type",
  "subject_id",
  "secondary_subject_id",
  "school_id",
  "idem_key",
  "payload",
] as const;

/**
 * The columns a caller may replace with a constructed value.
 *
 * `kind` is excluded because a kind decided by the statement rather than by the action would defeat
 * the union check; `payload` is excluded because it has its own merge, which composes with the
 * action's payload instead of discarding it.
 */
export type EventSubjectColumn = Exclude<(typeof EVENT_COLUMNS)[number], "kind" | "payload">;

/**
 * The values behind `EVENT_COLUMNS`, in that order. Shared with the standalone insert so the two
 * paths cannot disagree about what an event row contains.
 */
export function preparedEventValues(event: PreparedEvent): unknown[] {
  return [
    event.kind,
    event.actorAgentId ?? null,
    event.subjectType ?? null,
    event.subjectId ?? null,
    event.secondarySubjectId ?? null,
    event.schoolId ?? null,
    event.idemKey ?? null,
    JSON.stringify(event.payload ?? {}),
  ];
}

/**
 * Reject an event this build cannot describe, **before** anything is written.
 *
 * A kind outside the union is skipped by every drain without a receipt, so emitting one would
 * wedge the scan floor of every consumer at that id until a build that knows it is everywhere.
 * That is the correct behavior for an event a NEWER producer wrote; it is never correct for one
 * this build wrote itself. Memory mode also relies on this being the throwing part: validation
 * happens here, and the append that follows cannot fail (Decision 4).
 */
export function validatePreparedEvent(event: PreparedEvent): void {
  if (!isKnownEventKind(event.kind)) {
    throw new Error(`[events] refusing to emit unknown kind '${event.kind}'`);
  }
}

/** Where a rendered fragment sits: its own start, the caller's boundary, and its row source. */
interface RenderPlacement {
  first: number;
  callerParamBoundary: number;
  rowSource: string | null;
}

/**
 * Check and normalise the three options that say WHERE a fragment sits, before anything renders.
 *
 * Extracted as one unit because it is one question — "is this placement usable?" — asked of three
 * interdependent numbers, and because none of these checks may be skipped: `$0` is not a placeholder
 * at all; a fractional or oversized index renders SQL whose parameters bind to the caller's own
 * values; a boundary ABOVE the fragment's own start claims the fragment's placeholders as the
 * caller's, which is the direction that admits the bug rather than catching it; and a row source
 * that is not an identifier is interpolated straight into SQL text.
 */
function resolveRenderPlacement(options: EventStatementOptions): RenderPlacement {
  const first = options.firstParamIndex ?? 1;
  if (!Number.isSafeInteger(first) || first < 1) {
    throw new Error(`[events] firstParamIndex must be a positive integer, received ${first}`);
  }
  // Defaults to `first`, which is correct for a lone fragment: there, the caller's parameters do
  // stop exactly where this one's begin. A multi-event caller pins it instead.
  const callerParamBoundary = options.callerParamBoundary ?? first;
  if (!Number.isSafeInteger(callerParamBoundary) || callerParamBoundary < 1) {
    throw new Error(
      `[events] callerParamBoundary must be a positive integer, received ${callerParamBoundary}`
    );
  }
  if (callerParamBoundary > first) {
    throw new Error(
      `[events] callerParamBoundary ($${callerParamBoundary}) cannot exceed firstParamIndex ($${first})`
    );
  }
  if (options.rowSource !== undefined && !CTE_NAME.test(options.rowSource)) {
    throw new Error(`[events] '${options.rowSource}' is not a usable row-source CTE name`);
  }
  return { first, callerParamBoundary, rowSource: options.rowSource ?? null };
}

/**
 * Render `event` as an insert gated on `decisiveCte`.
 *
 * Usage — the decisive mutation returns rows only when it actually happened:
 *
 *   const emit = emitEventStatement(event, "deleted", { firstParamIndex: params.length + 1 });
 *   await sql(`WITH deleted AS (UPDATE posts SET … WHERE … RETURNING id) ${emit.text}`,
 *             [...params, ...emit.params]);
 *
 * `RETURNING id, created_at, subject_id` is part of the fragment because the caller needs all three,
 * and only this statement has them atomically with the write.
 *
 * **`subject_id` is returned for the per-row fan-out, and it is the only safe way to correlate one.**
 * A `rowSource` fragment emits one event per row of its source, so a caller that must stamp each
 * subject's transitional projection has N events and N subjects to pair up — and sibling
 * data-modifying CTEs execute in an unspecified order, so pairing them by id order is not a fact the
 * statement establishes. Selecting `WHERE ev.subject_id = src.id` is.
 *
 * The id is the notification dedup key's third segment (`{type}:{agent_id}:{event_id}`). The
 * timestamp is what makes the ACTIVITY projections comparable across the dual-write phase: the
 * consumer projects `occurred_at` from the event row for kinds whose subject carries no timestamp
 * of its own — a follow has no `created_at` anywhere but the event — while the legacy inline writer
 * stamps its own `new Date()`. Two clocks cannot agree, so u3's transitional writers stamp the
 * event's `created_at` into `occurred_at` alongside `source_event_id`, and both sides then project
 * the same instant. Returning only the id would leave that value unavailable to the writer that
 * needs it.
 */
export function emitEventStatement(
  event: PreparedEvent,
  decisiveCte: string,
  options: EventStatementOptions = {}
): EventStatementFragment {
  validatePreparedEvent(event);
  if (!CTE_NAME.test(decisiveCte)) {
    throw new Error(`[events] '${decisiveCte}' is not a usable CTE name`);
  }

  const { first, callerParamBoundary, rowSource } = resolveRenderPlacement(options);
  const values = preparedEventValues(event);
  const overrides = options.columnSql ?? {};
  const params: unknown[] = [];
  const scope: RenderScope = { callerParamBoundary, rowSource };

  const expressions = EVENT_COLUMNS.map((column, i) => {
    const override =
      column === "kind" || column === "payload" ? undefined : overrides[column as EventSubjectColumn];
    if (override !== undefined) {
      // Re-validated here, not trusted from the type: `renderValue` re-checks the brand and every
      // field, and bounds a `$n` reference against the caller's own parameter space.
      return renderValue(override, scope, `columnSql['${column}']`);
    }
    // Parameters are numbered by how many have actually been emitted, not by column index: an
    // overridden column consumes none, and this driver rejects a bind carrying a parameter the
    // statement never references.
    const placeholder = `$${first + params.length}`;
    params.push(values[i]);
    // `payload` is the last column and the only non-text one; the cast is what makes the driver's
    // string land as JSONB rather than as a quoted JSON string.
    return column === "payload" ? `${placeholder}::jsonb` : placeholder;
  });

  if (options.payloadMergeSql !== undefined) {
    const payloadIndex = EVENT_COLUMNS.indexOf("payload");
    // `||` on two JSONB objects is a shallow right-biased merge, so the statement's values win over
    // the action's placeholders for exactly the keys it fills and leave every other key alone.
    expressions[payloadIndex] =
      `(${expressions[payloadIndex]} || (${renderPayloadObject(options.payloadMergeSql, scope)}))`;
  }

  // One event per row of the row source — or exactly one, built from constants, when there is none.
  // Either way gated on the decisive mutation having produced any row at all.
  return {
    text:
      `INSERT INTO events (${EVENT_COLUMNS.join(", ")})\n` +
      `SELECT ${expressions.join(", ")}${rowSource ? ` FROM ${rowSource}` : ""}` +
      ` WHERE EXISTS (SELECT 1 FROM ${decisiveCte})\n` +
      `RETURNING id, created_at, subject_id`,
    params,
  };
}

/** One rendered prepared-events list, ready to splice into a caller's `WITH` list. */
export interface PreparedEventCtes {
  /** `name AS (…)` clauses in order. Empty when the caller passed no events. */
  ctes: string[];
  /** The CTE names, in the same order as the events. `names[0]` is the primary event's. */
  names: string[];
  /** Values for the placeholders, appended after the caller's own parameters. */
  params: unknown[];
}

/** What a single event's render may substitute. Applied to ONE event, never to the whole list. */
export interface EventRenderOverrides {
  /** Constructed values replacing a subject column's parameter — see `EventStatementOptions`. */
  columnSql?: Partial<Record<EventSubjectColumn, EventValueSql>>;
  /** A constructed JSONB object merged over that event's prepared payload. */
  payloadMergeSql?: PayloadObjectSql;
  /**
   * The CTE THIS event selects `FROM` — one row of it, one event.
   *
   * Per event rather than per call for the same reason the substitutions are: the primary event is
   * one row built from the mutation's own values, while a derived fan-out is one row per target. A
   * shared row source would multiply the primary event by the fan-out's cardinality.
   */
  rowSource?: string;
}

export interface EmitEventCtesOptions {
  /**
   * 1-based index of the first placeholder the FIRST event may use. Later events continue from where
   * the previous one stopped.
   */
  firstParamIndex?: number;
  /**
   * 1-based index where the CALLER's own parameters stop — the validation boundary, **fixed for the
   * whole statement**. Defaults to this call's `firstParamIndex`, which is correct for the single
   * render that most callers make.
   *
   * **A COMPOSED caller must pass the first render's boundary, and this option is the only way to.**
   * Two renders spliced into one `WITH` list (a primary event plus a derived fan-out, via distinct
   * `namePrefix`es) give the second call a `firstParamIndex` *above* the first render's own
   * placeholders. Left to the default, the second render would treat those placeholders as caller
   * space and admit a `sqlParam` pointing straight at a PRIOR EVENT's bound column — a real `$n`,
   * silently bound, while the API promises the caller's own parameters. That is the same defect
   * `callerParamBoundary` closes *within* one render, reappearing one level up as soon as two renders
   * compose, so the boundary has to be passable rather than derived.
   *
   * It may not exceed `firstParamIndex`: the other direction claims the fragments' own placeholders
   * as the caller's, which admits the bug instead of catching it.
   */
  callerParamBoundary?: number;
  /**
   * Per-event substitutions, **by position**: `overrides[i]` applies to `events[i]` and to nothing
   * else.
   *
   * **Keyed by index rather than by kind, and per event rather than per call**, because both of the
   * alternatives are wrong in the shape this parameter exists for. A single set applied to the whole
   * list is what the primary+derived case cannot survive: a comment's `agent.mentioned` fan-out
   * carries a different subject per row, and giving every event the primary's `subject_id` override
   * would point every derived event at the comment instead of at its mention target. Keying by kind
   * cannot express two events of the SAME kind with different subjects, which is exactly that fan-out.
   *
   * A shorter array leaves the remaining events unsubstituted; a longer one is a configuration error
   * and throws, because it means the caller is describing an event it did not pass.
   */
  overrides?: ReadonlyArray<EventRenderOverrides | undefined>;
  /**
   * CTE name prefix, validated as an identifier. Defaults to `ev`, giving `ev_0`, `ev_1`, ….
   *
   * **This is what makes two renders compose.** Names restart at index 0 on every call, so a caller
   * that renders a primary event and a derived fan-out through two calls against one decisive CTE
   * would otherwise define `ev_0` twice and the statement would not parse. A distinct prefix per call
   * (with distinct `firstParamIndex`) makes the two blocks splice into one `WITH` list.
   */
  namePrefix?: string;
}

/**
 * Render the Decision-2 prepared-events parameter as gated CTEs.
 *
 * **Every event is gated on the SAME decisive CTE**, which is what the parameter means: an action
 * hands the store a primary event plus whatever derived events must commit atomically with it (a
 * comment's `agent.mentioned` fan-out, later), and none of them may exist unless the mutation did.
 * The names are positional (`ev_0`, `ev_1`, …) so a caller can project the primary event's returned
 * `id`/`created_at` — the two values the transitional inline writers stamp, and the only place they
 * are available atomically with the write.
 *
 * An empty or absent list renders nothing at all, so the same statement text serves a store call
 * that was given no events (every non-action caller: fixtures, reconciliation, the seeds).
 */
export function emitEventCtes(
  events: readonly PreparedEvent[] | undefined,
  decisiveCte: string,
  options: EmitEventCtesOptions = {}
): PreparedEventCtes {
  const rendering: PreparedEventCtes = { ctes: [], names: [], params: [] };
  const list = events ?? [];
  const first = options.firstParamIndex ?? 1;
  // Defaults to this call's own start — right for a lone render, wrong for the second of two, which
  // is why it is an option. `emitEventStatement` re-validates it (positive, and never above the
  // fragment's start).
  const boundary = options.callerParamBoundary ?? first;
  const prefix = options.namePrefix ?? "ev";
  if (!CTE_NAME.test(prefix)) throw new Error(`[events] '${prefix}' is not a usable CTE name prefix`);
  const overrides = options.overrides ?? [];
  if (overrides.length > list.length) {
    throw new Error(
      `[events] ${overrides.length} render override(s) were supplied for ${list.length} event(s)`
    );
  }

  for (const [index, event] of list.entries()) {
    const perEvent = overrides[index] ?? {};
    const fragment = emitEventStatement(event, decisiveCte, {
      // The placeholder counter MOVES — each event continues where the previous one stopped — while
      // the validation boundary stays pinned at the caller's. Using one number for both is what let
      // a later event's `sqlParam` reach into an earlier event's bound values, and passing THIS
      // call's start rather than the supplied boundary is the same mistake across two composed
      // renders.
      firstParamIndex: first + rendering.params.length,
      callerParamBoundary: boundary,
      columnSql: perEvent.columnSql,
      payloadMergeSql: perEvent.payloadMergeSql,
      rowSource: perEvent.rowSource,
    });
    const name = `${prefix}_${index}`;
    rendering.ctes.push(`${name} AS (\n${fragment.text}\n)`);
    rendering.names.push(name);
    rendering.params.push(...fragment.params);
  }
  return rendering;
}
