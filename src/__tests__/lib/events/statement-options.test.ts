/**
 * M11-2 u3 — the value vocabulary `emitEventStatement` renders, and the CTE renderer built on it.
 *
 * u1 left this shape deliberately unbuilt and named the chunk that would need it: "derived events
 * whose subjects vary PER ROW need column substitution from the CTE … that shape arrives with the
 * prepared-events store parameter in u3".
 *
 * Four properties are pinned here, cheaply, where the statements themselves are expensive (they run
 * against Postgres in `src/__tests__/integration/m11-2-u3-posts.test.ts`):
 *
 *  1. **The interpolation surface is CLOSED, at runtime and not only at compile time.** The options
 *     take opaque descriptions, and the renderer re-validates every field. Branding alone stops a
 *     typed caller; the re-validation is what stops an untyped one and a forged object.
 *  2. **A `$n` reference is BOUNDED.** A constructor cannot know where the caller's parameter space
 *     ends, so the bound is applied at render against `firstParamIndex`.
 *  3. **Substitutions are PER EVENT.** One set applied to a whole list is what the primary+derived
 *     case cannot survive.
 *  4. **Parameter numbering.** An overridden column consumes no placeholder, because this driver
 *     refuses a bind carrying a parameter the statement never references.
 *
 * @jest-environment node
 */
import type { PreparedEvent } from "@/lib/events/kinds";
import {
  emitEventCtes,
  emitEventStatement,
  sqlColumn,
  sqlJsonAgg,
  sqlParam,
  sqlPayloadObject,
  type EventValueSql,
} from "@/lib/store/events/statement";

const EVENT: PreparedEvent = {
  kind: "post.created",
  actorAgentId: "agent_1",
  subjectType: "post",
  subjectId: "placeholder",
  payload: { post_id: "placeholder", group_id: "group_1", author_id: "agent_1" },
};

/** Render one value into a statement and hand back the SQL text, so assertions read the real thing. */
function renderedWith(value: EventValueSql, firstParamIndex = 5): string {
  return emitEventStatement(EVENT, "p", { firstParamIndex, columnSql: { subject_id: value } }).text;
}

describe("the constructors validate their inputs", () => {
  /**
   * Each of these would otherwise reach the SQL text verbatim — a second statement, a comment that
   * swallows the rest of the line, a quote that closes a literal.
   */
  it.each([
    ["a second statement", () => sqlColumn("id; DROP TABLE events")],
    ["a comment", () => sqlColumn("id --")],
    ["a quote", () => sqlColumn("id' || (SELECT api_key FROM agents) || '")],
    ["a function call", () => sqlColumn("pg_sleep(10)")],
    ["a three-part path", () => sqlColumn("a.b.c")],
    ["an expression cast", () => sqlParam(1, "text) || (SELECT 1")],
    ["a fractional parameter index", () => sqlParam(1.5)],
    ["a zero parameter index", () => sqlParam(0)],
    ["a CTE name that is not an identifier", () => sqlJsonAgg({ cte: "thread t, agents", column: "id" })],
    ["an aggregate column that is not an identifier", () => sqlJsonAgg({ cte: "thread", column: "id)" })],
    [
      "an order column that is not an identifier",
      () => sqlJsonAgg({ cte: "thread", column: "id", orderBy: "id) --" }),
    ],
    [
      "a payload key that is not an identifier",
      () => sqlPayloadObject({ "post_id', (SELECT 1)) -- ": sqlParam(1) }),
    ],
  ])("refuses %s", (_name, build) => {
    expect(build).toThrow();
  });

  it("refuses an empty payload object rather than rendering jsonb_build_object()", () => {
    expect(() => sqlPayloadObject({})).toThrow(/at least one entry/);
  });

  it("refuses a value that was not built here", () => {
    // A payload object may only hold constructed values, checked where it is built.
    expect(() => sqlPayloadObject({ post_id: "$1::text" as unknown as EventValueSql })).toThrow(
      /not built by this module/
    );
  });
});

/**
 * The runtime half. Branding is a compile-time claim; these are the callers it cannot reach — an
 * untyped one, and one that lifted the brand off a real value.
 */
describe("the renderer re-validates, so branding is not the only defence", () => {
  it("refuses a plain object that merely looks like a description", () => {
    const forged = { form: "column", ref: "id" } as unknown as EventValueSql;
    expect(() => renderedWith(forged)).toThrow(/not built by this module/);
  });

  it("refuses a forged object carrying a brand lifted off a real value", () => {
    // `Object.getOwnPropertySymbols` is all it takes to copy the brand, so the brand alone cannot be
    // the boundary. The field check at render time is.
    const brand = Object.getOwnPropertySymbols(sqlParam(1))[0];
    const forged = { [brand]: true, form: "column", ref: "id; DROP TABLE events" } as unknown as EventValueSql;
    expect(() =>
      emitEventStatement(EVENT, "p", {
        firstParamIndex: 5,
        rowSource: "src",
        columnSql: { subject_id: forged },
      })
    ).toThrow(/not a usable SQL identifier/);
  });

  it("refuses a branded object with an unknown form", () => {
    const brand = Object.getOwnPropertySymbols(sqlParam(1))[0];
    const forged = { [brand]: true, form: "raw", text: "1=1" } as unknown as EventValueSql;
    expect(() => renderedWith(forged)).toThrow(/unknown value form/);
  });

  it("refuses a forged payload merge object", () => {
    const brand = Object.getOwnPropertySymbols(sqlParam(1))[0];
    const forged = {
      [brand]: true,
      form: "payload_object",
      entries: [["post_id') || (SELECT 1) || ('", sqlParam(1)]],
    } as unknown as ReturnType<typeof sqlPayloadObject>;
    expect(() =>
      emitEventStatement(EVENT, "p", { firstParamIndex: 5, payloadMergeSql: forged })
    ).toThrow(/not a usable SQL identifier/);
  });

  it("cannot be edited after construction", () => {
    const value = sqlColumn("t.id") as unknown as { ref: string };
    expect(() => {
      value.ref = "t.id; DROP TABLE events";
    }).toThrow();
  });
});

/**
 * The bound a constructor cannot apply, because it does not know where the caller's parameters end.
 *
 * A reference at or above `firstParamIndex` points at the event's OWN placeholders — or past the end
 * of the statement — so it would read somebody else's value or fail as an opaque bind error.
 */
describe("a $n reference is bounded at render time", () => {
  it("accepts a reference inside the caller's own parameter space", () => {
    expect(renderedWith(sqlParam(4, "text"), 5)).toContain("$4::text");
  });

  it("refuses a reference into the fragment's own parameters", () => {
    expect(() => renderedWith(sqlParam(5), 5)).toThrow(/not one of the caller's own parameters/);
    expect(() => renderedWith(sqlParam(99), 5)).toThrow(/not one of the caller's own parameters/);
  });

  it("refuses any reference when the fragment is the whole statement", () => {
    // `firstParamIndex` defaults to 1, so there is no caller space at all to point into.
    expect(() => renderedWith(sqlParam(1), 1)).toThrow(/not one of the caller's own parameters/);
  });

  /**
   * **The boundary does not move with the events.**
   *
   * Each rendered event's placeholders continue where the previous one's stopped, so its
   * `firstParamIndex` sits *above* the earlier events' values. Validating against that moving number
   * would accept a `sqlParam` pointing into a PRIOR EVENT's bound parameters — a real `$n` holding
   * somebody else's event column, silently bound, while the API promises the caller's own space. So
   * the boundary is pinned at the first event's start and only the placeholder counter moves.
   */
  it("refuses a later event's reference into a PRIOR event's parameters", () => {
    // The caller owns $1..$2; event 0 renders $3..$10; event 1 renders $11..$18.
    const intoPriorEvent = () =>
      emitEventCtes([EVENT, EVENT], "p", {
        firstParamIndex: 3,
        overrides: [undefined, { columnSql: { subject_id: sqlParam(5) } }],
      });
    expect(intoPriorEvent).toThrow(/not one of the caller's own parameters \(they end at \$2\)/);

    // …and into its OWN parameters, which the moving number would also have admitted for event 1.
    expect(() =>
      emitEventCtes([EVENT, EVENT], "p", {
        firstParamIndex: 3,
        overrides: [undefined, { columnSql: { subject_id: sqlParam(12) } }],
      })
    ).toThrow(/not one of the caller's own parameters/);
  });

  it("still accepts a later event's reference into the caller's own parameters", () => {
    const rendering = emitEventCtes([EVENT, EVENT], "p", {
      firstParamIndex: 3,
      overrides: [undefined, { columnSql: { subject_id: sqlParam(2, "text") } }],
    });
    expect(rendering.ctes[1]).toContain("$2::text");
  });

  it("refuses a boundary above the fragment's own start", () => {
    // That direction claims the fragment's own placeholders as the caller's — it admits the bug
    // rather than catching it.
    expect(() =>
      emitEventStatement(EVENT, "p", { firstParamIndex: 3, callerParamBoundary: 4 })
    ).toThrow(/cannot exceed firstParamIndex/);
  });
});

/**
 * A column reference needs somewhere to resolve, and the renderer is the only place that knows.
 *
 * Without `rowSource` the insert's `SELECT` has no `FROM` at all, so `sqlColumn` would render SQL
 * that raises `42703`/`42P01` on its first execution — the shape the vocabulary used to advertise
 * and the renderer could not produce. The executed proof is in
 * `src/__tests__/integration/m11-2-u3-posts.test.ts`; these are the refusals.
 */
describe("a column reference is bound to the fragment's row source", () => {
  it("refuses a column when the fragment selects FROM nothing", () => {
    expect(() => renderedWith(sqlColumn("id"))).toThrow(/selects FROM no row source/);
    expect(() => renderedWith(sqlColumn("targets.id"))).toThrow(/selects FROM no row source/);
  });

  it("refuses a qualifier naming any relation but the row source", () => {
    expect(() =>
      emitEventStatement(EVENT, "p", {
        firstParamIndex: 5,
        rowSource: "targets",
        columnSql: { subject_id: sqlColumn("agents.id") },
      })
    ).toThrow(/selects FROM 'targets'/);
  });

  it("accepts a bare column and a matching qualifier, and selects FROM the row source", () => {
    const bare = emitEventStatement(EVENT, "p", {
      firstParamIndex: 5,
      rowSource: "targets",
      columnSql: { subject_id: sqlColumn("agent_id") },
    });
    expect(bare.text).toContain("FROM targets WHERE EXISTS (SELECT 1 FROM p)");

    const qualified = emitEventStatement(EVENT, "p", {
      firstParamIndex: 5,
      rowSource: "targets",
      columnSql: { subject_id: sqlColumn("targets.agent_id") },
    });
    expect(qualified.text).toContain("targets.agent_id");
  });

  it("keeps the decisive gate, so a fan-out of any size still emits nothing on a no-op", () => {
    const fragment = emitEventStatement(EVENT, "decisive", {
      firstParamIndex: 5,
      rowSource: "targets",
    });
    expect(fragment.text).toContain("FROM targets WHERE EXISTS (SELECT 1 FROM decisive)");
  });

  it("refuses a row source that is not an identifier", () => {
    expect(() =>
      emitEventStatement(EVENT, "p", { firstParamIndex: 5, rowSource: "targets, agents" })
    ).toThrow(/not a usable row-source CTE name/);
  });

  it("keeps the row source PER EVENT, so a primary event is not multiplied by a fan-out", () => {
    const rendering = emitEventCtes([EVENT, EVENT], "p", {
      firstParamIndex: 3,
      overrides: [undefined, { rowSource: "targets" }],
    });
    expect(rendering.ctes[0]).not.toContain("FROM targets");
    expect(rendering.ctes[1]).toContain("FROM targets");
  });
});

describe("rendered SQL", () => {
  it("renders a parameter", () => {
    expect(renderedWith(sqlParam(4, "text"), 5)).toContain("$4::text");
  });

  /**
   * `jsonb_agg(DISTINCT x)` promises deduplication and says nothing about output order, while the
   * memory store builds the same list with `Array.prototype.sort` — so the shadow soak would diff two
   * correct payloads and report a mismatch. Aggregating over an ordered `SELECT DISTINCT` removes the
   * question.
   */
  it("orders every aggregate, including the distinct one", () => {
    expect(renderedWith(sqlJsonAgg({ cte: "thread", column: "id" }))).toContain(
      "jsonb_agg(src.id ORDER BY src.id)"
    );
    expect(renderedWith(sqlJsonAgg({ cte: "audience", column: "id", orderBy: "ord" }))).toContain(
      "jsonb_agg(src.id ORDER BY src.ord)"
    );
    const distinct = renderedWith(sqlJsonAgg({ cte: "thread", column: "author_id", distinct: true }));
    expect(distinct).toContain("jsonb_agg(src.author_id ORDER BY src.author_id)");
    expect(distinct).toContain("SELECT DISTINCT author_id FROM thread");
    expect(distinct).not.toContain("jsonb_agg(DISTINCT");
  });

  it("renders an empty aggregate as an empty array, not NULL", () => {
    // A NULL would reach `payloadIdList` as "not an array" and dead-letter every childless post.
    expect(renderedWith(sqlJsonAgg({ cte: "thread", column: "id" }))).toContain("'[]'::jsonb");
  });

  it("merges the payload object over the prepared payload, so the statement's values win", () => {
    const fragment = emitEventStatement(EVENT, "p", {
      firstParamIndex: 5,
      payloadMergeSql: sqlPayloadObject({ post_id: sqlParam(1, "text") }),
    });
    // Right-biased `||`: the action's keys survive and the statement replaces only what it fills.
    expect(fragment.text).toContain("($12::jsonb || (jsonb_build_object('post_id', $1::text)))");
    expect(fragment.params).toHaveLength(8);
  });
});

describe("columnSql parameter numbering", () => {
  it("replaces the column and consumes no placeholder, renumbering the rest", () => {
    const plain = emitEventStatement(EVENT, "p", { firstParamIndex: 5 });
    const overridden = emitEventStatement(EVENT, "p", {
      firstParamIndex: 5,
      columnSql: { subject_id: sqlParam(1, "text") },
    });

    expect(plain.params).toHaveLength(8);
    expect(overridden.params).toHaveLength(7);
    // `subject_id` is the 4th column: its value is gone from the parameter list, and every later
    // column has moved down one placeholder rather than leaving a hole.
    expect(overridden.params).toEqual(plain.params.filter((_, index) => index !== 3));
    expect(overridden.text).toContain("$5, $6, $7, $1::text, $8, $9, $10");
    expect(overridden.text).toContain("$11::jsonb");
  });
});

describe("emitEventCtes", () => {
  it("renders nothing at all for an absent or empty list", () => {
    for (const events of [undefined, []]) {
      expect(emitEventCtes(events, "p")).toEqual({ ctes: [], names: [], params: [] });
    }
  });

  it("names CTEs positionally and threads the parameter offset across them", () => {
    const rendering = emitEventCtes([EVENT, EVENT], "p", { firstParamIndex: 3 });

    expect(rendering.names).toEqual(["ev_0", "ev_1"]);
    expect(rendering.ctes[0].startsWith("ev_0 AS (")).toBe(true);
    expect(rendering.params).toHaveLength(16);
    // The second event's placeholders continue where the first's ended — a shared offset would make
    // both events read the same eight values.
    expect(rendering.ctes[0]).toContain("$3, $4, $5, $6, $7, $8, $9, $10::jsonb");
    expect(rendering.ctes[1]).toContain("$11, $12, $13, $14, $15, $16, $17, $18::jsonb");
  });

  /**
   * The primary+derived shape, which is the reason substitutions are per event.
   *
   * One set applied to the whole list would give the derived event the primary's `subject_id`, and a
   * mention fan-out would point every derived event at the comment instead of at its mention target.
   */
  it("applies each override to its own event and to no other", () => {
    const rendering = emitEventCtes([EVENT, EVENT], "p", {
      firstParamIndex: 3,
      overrides: [
        { columnSql: { subject_id: sqlParam(1, "text") } },
        { columnSql: { subject_id: sqlParam(2, "text") } },
      ],
    });

    expect(rendering.ctes[0]).toContain("$1::text");
    expect(rendering.ctes[0]).not.toContain("$2::text");
    expect(rendering.ctes[1]).toContain("$2::text");
    expect(rendering.ctes[1]).not.toContain("$1::text");
  });

  it("leaves an event without an override unsubstituted", () => {
    const rendering = emitEventCtes([EVENT, EVENT], "p", {
      firstParamIndex: 3,
      overrides: [{ columnSql: { subject_id: sqlParam(1, "text") } }],
    });
    expect(rendering.ctes[0]).toContain("$1::text");
    expect(rendering.ctes[1]).not.toContain("$1::text");
    // The second event still binds all eight of its own values; the first bound only seven.
    expect(rendering.params).toHaveLength(15);
  });

  it("refuses more overrides than events, because that describes an event nobody passed", () => {
    expect(() => emitEventCtes([EVENT], "p", { firstParamIndex: 3, overrides: [{}, {}] })).toThrow(
      /2 render override\(s\) were supplied for 1 event/
    );
  });

  /**
   * Composition: two renders against one decisive CTE, spliced into one `WITH` list.
   *
   * Without a prefix both calls define `ev_0` and the statement does not parse — which is what makes
   * this an API property rather than a naming preference.
   */
  it("composes two renders through distinct name prefixes and offsets", () => {
    const primary = emitEventCtes([EVENT], "p", { firstParamIndex: 3 });
    const derived = emitEventCtes([EVENT], "p", {
      firstParamIndex: 3 + primary.params.length,
      namePrefix: "der",
    });

    expect(primary.names).toEqual(["ev_0"]);
    expect(derived.names).toEqual(["der_0"]);
    expect(new Set([...primary.names, ...derived.names]).size).toBe(2);
    expect(derived.ctes[0]).toContain("$11, $12, $13, $14, $15, $16, $17, $18::jsonb");
  });

  /**
   * **The boundary does not move with the RENDERS either.**
   *
   * Within one render it is pinned so a later event cannot reach into an earlier one's bound values.
   * Two composed renders reproduce that geometry one level up: the second call's `firstParamIndex`
   * sits above the FIRST render's placeholders, so defaulting the boundary to it would accept a
   * `sqlParam` naming a prior event's column — a real `$n`, silently bound, while the API promises
   * the caller's own parameters. A composed caller therefore passes the first render's boundary, and
   * the caller's true space ($1..$2 here) still renders.
   */
  it("keeps the caller's boundary across composed renders", () => {
    // The caller owns $1..$2; render 1 renders $3..$10; render 2 renders $11..$18.
    const primary = emitEventCtes([EVENT], "p", { firstParamIndex: 3 });
    const composed = (value: ReturnType<typeof sqlParam>) =>
      emitEventCtes([EVENT], "p", {
        firstParamIndex: 3 + primary.params.length,
        callerParamBoundary: 3,
        namePrefix: "der",
        overrides: [{ columnSql: { subject_id: value } }],
      });

    // Into the FIRST render's event parameters — which the default boundary would have admitted.
    expect(() => composed(sqlParam(5))).toThrow(
      /not one of the caller's own parameters \(they end at \$2\)/
    );
    // …and into its own, for the same reason.
    expect(() => composed(sqlParam(12))).toThrow(/not one of the caller's own parameters/);
    // The caller's real space is untouched.
    expect(composed(sqlParam(2, "text")).ctes[0]).toContain("$2::text");

    // The default is each call's OWN start, which is right for a lone render and blind to a prior
    // one: the same reference renders happily without the option. That is what makes passing the
    // boundary a requirement of composition rather than a decoration.
    expect(() =>
      emitEventCtes([EVENT], "p", {
        firstParamIndex: 3 + primary.params.length,
        namePrefix: "der",
        overrides: [{ columnSql: { subject_id: sqlParam(5) } }],
      })
    ).not.toThrow();
  });

  it("refuses a composed boundary above its own start", () => {
    expect(() =>
      emitEventCtes([EVENT], "p", { firstParamIndex: 3, callerParamBoundary: 4 })
    ).toThrow(/cannot exceed firstParamIndex/);
  });

  it("refuses a name prefix that is not an identifier", () => {
    expect(() => emitEventCtes([EVENT], "p", { namePrefix: "ev) SELECT 1 --" })).toThrow(
      /not a usable CTE name prefix/
    );
  });

  it("gates every event on the same decisive CTE", () => {
    for (const cte of emitEventCtes([EVENT, EVENT], "decisive").ctes) {
      expect(cte).toContain("WHERE EXISTS (SELECT 1 FROM decisive)");
      expect(cte).toContain("RETURNING id, created_at");
    }
  });

  it("refuses a CTE name that is not an identifier", () => {
    expect(() => emitEventCtes([EVENT], "p) SELECT 1 --")).toThrow(/not a usable CTE name/);
  });

  it("refuses a kind this build does not know, before anything is rendered", () => {
    expect(() =>
      emitEventCtes([{ ...EVENT, kind: "post.invented" } as unknown as PreparedEvent], "p")
    ).toThrow(/refusing to emit unknown kind/);
  });
});
