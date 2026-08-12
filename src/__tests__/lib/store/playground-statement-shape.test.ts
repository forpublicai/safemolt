/**
 * M11-2 u3d (P1.4) — the SHAPE of the playground db statements, asserted without a database.
 *
 * **Why a shape test and not only an integration test.** These statements carry the whole of the
 * chunk's coupling: an event that is not gated on the decisive CTE is a ghost, an event rendered
 * outside the mutating statement is a second commit, and a fan-out that emits one constant event
 * describes one expired session and loses the rest. Those are properties of the rendered SQL, and
 * they can be read off it — so they are checked here, on every `npm test`, rather than only where a
 * Postgres branch happens to be configured.
 *
 * It does not replace the integration suite: only a real database proves the SQL PARSES and that the
 * locks behave. It proves the parts a reviewer would otherwise have to re-derive by eye.
 *
 * @jest-environment node
 */
const captured: Array<{ text: string; params: unknown[] }> = [];

jest.mock("@/lib/db", () => {
  // `sql` is used both as a tagged template (the legacy statements) and as a function taking text
  // plus parameters (every statement u3d touched). The stand-in answers both, records what it was
  // asked to run, and returns no rows — every caller here is inspected for its TEXT.
  const sql = (first: unknown, ...rest: unknown[]) => {
    if (Array.isArray(first) && "raw" in (first as object)) {
      const strings = first as unknown as TemplateStringsArray;
      captured.push({ text: strings.join("?"), params: rest });
    } else {
      captured.push({ text: String(first), params: (rest[0] as unknown[]) ?? [] });
    }
    return Promise.resolve([]);
  };
  return { sql, hasDatabase: () => true };
});

import {
  applyPlaygroundResolution,
  cancelPlaygroundSession,
  completePlaygroundSessionAtLifetimeCap,
  createPlaygroundSession,
  expireStalePendingSessions,
  joinPlaygroundSessionWithOutcome,
  submitPlaygroundActionGated,
} from "@/lib/store/playground/db";
import {
  playgroundSessionCompletedEvent,
  playgroundSessionCreatedEvent,
  playgroundSessionExpiredEvent,
} from "@/lib/actions/playground-events";
import type { PreparedEvent } from "@/lib/events/kinds";
import { STORE_ASSIGNED_PAYLOAD_ID } from "@/lib/events/kinds";

/** The one statement a call rendered, when the call renders exactly one. */
function onlyStatement(): { text: string; params: unknown[] } {
  expect(captured).toHaveLength(1);
  return captured[0];
}

/** `$n` placeholders are numbered, contiguous from 1, and every one has a value. */
function assertPlaceholdersBind(statement: { text: string; params: unknown[] }): void {
  const referenced = new Set(
    [...statement.text.matchAll(/\$(\d+)/g)].map((match) => Number(match[1]))
  );
  const highest = Math.max(...referenced);
  expect(statement.params).toHaveLength(highest);
  // Contiguous: a gap means the driver is handed a value the statement never references, which this
  // driver rejects outright.
  for (let index = 1; index <= highest; index += 1) {
    expect(referenced.has(index)).toBe(true);
  }
}

const sessionEvent = (kind: PreparedEvent["kind"]) =>
  ({
    kind,
    actorAgentId: "agent_1",
    subjectType: "playground_session",
    subjectId: "sess_1",
    schoolId: "foundation",
    payload: {},
  }) as PreparedEvent;

beforeEach(() => {
  captured.length = 0;
});

describe("every playground event insert is GATED on its decisive CTE", () => {
  it("createPlaygroundSession gates on the insert and substitutes the minted id", async () => {
    // The stand-in returns no rows, so the row mapper afterwards throws. The STATEMENT is what this
    // test is about, and it is captured before that.
    await expect(
      createPlaygroundSession(
        {
          id: "sess_1",
          gameId: "pub-debate",
          participants: [],
          maxRounds: 6,
          currentRound: 0,
          status: "pending",
          schoolId: "foundation",
        },
        [playgroundSessionCreatedEvent({ actorAgentId: "agent_1", schoolId: "foundation" })]
      )
    ).rejects.toBeDefined();

    const statement = onlyStatement();
    expect(statement.text).toContain("WITH created AS (");
    expect(statement.text).toContain("INSERT INTO events");
    expect(statement.text).toContain("WHERE EXISTS (SELECT 1 FROM created)");
    // `subject_id` is the id parameter, not the action's marker: the store mints it.
    expect(statement.text).toContain("$1::text");
    expect(statement.params).not.toContain(STORE_ASSIGNED_PAYLOAD_ID);
    assertPlaceholdersBind(statement);
  });

  it("submitPlaygroundActionGated gates on the insert and takes ON CONFLICT DO NOTHING", async () => {
    await submitPlaygroundActionGated(
      { id: "act_1", sessionId: "sess_1", agentId: "agent_1", round: 2, content: "move" },
      [
        {
          ...sessionEvent("playground.action_submitted"),
          idemKey: "playground_action:sess_1:2:agent_1",
          payload: { session_id: "sess_1", round: 2, agent_id: "agent_1" },
        } as PreparedEvent,
      ]
    );

    // The gated insert renders one statement; the refusal classification then re-reads, which is
    // advisory and documented. Only the FIRST is the decisive one.
    const statement = captured[0];
    expect(statement.text).toContain("WITH inserted AS (");
    expect(statement.text).toContain("ON CONFLICT (session_id, agent_id, round) DO NOTHING");
    expect(statement.text).toContain("WHERE EXISTS (SELECT 1 FROM inserted)");
    // The duplicate-race loser inserts nothing, so the event insert reads zero rows and emits none.
    expect(statement.text.indexOf("ON CONFLICT")).toBeLessThan(
      statement.text.indexOf("INSERT INTO events")
    );
    expect(statement.params).toContain("playground_action:sess_1:2:agent_1");
    assertPlaceholdersBind(statement);
  });

  it("cancelPlaygroundSession gates on the participant-scoped transition", async () => {
    await cancelPlaygroundSession("sess_1", "agent_1", "done", [
      sessionEvent("playground.session_cancelled"),
    ]);

    const statement = captured[0];
    expect(statement.text).toContain("WHERE EXISTS (SELECT 1 FROM cancelled)");
    // The authorization IS the gate: containment sits inside the same UPDATE the event reads.
    const cancelledCte = statement.text.slice(
      statement.text.indexOf("cancelled AS ("),
      statement.text.indexOf("swept AS (")
    );
    expect(cancelledCte).toContain("participants @> $4::jsonb");
    expect(cancelledCte).toContain("status IN ('pending', 'active')");
    assertPlaceholdersBind(statement);
  });

  it("completePlaygroundSessionAtLifetimeCap gates on a CONDITIONAL transition", async () => {
    await completePlaygroundSessionAtLifetimeCap(
      "sess_1",
      { summary: "capped", completedAt: new Date().toISOString() },
      [
        playgroundSessionCompletedEvent({
          sessionId: "sess_1",
          schoolId: "foundation",
          reason: "lifetime_cap",
        }),
      ]
    );

    const statement = onlyStatement();
    expect(statement.text).toContain("WHERE EXISTS (SELECT 1 FROM capped)");
    // The predicate is what makes a second sweep write nothing and emit nothing.
    expect(statement.text).toContain("AND status = 'active'");
    expect(statement.text).toContain("AND completed_at IS NULL");
    assertPlaceholdersBind(statement);
  });
});

describe("the expiry sweep emits ONE event PER ROW", () => {
  it("renders the fan-out from the expired CTE, with each row's own subject", async () => {
    await expireStalePendingSessions(1000, [playgroundSessionExpiredEvent()]);

    const statement = onlyStatement();
    // `FROM expired` is the row source: one row of the sweep, one event. Without it the fragment
    // would emit exactly one event built from constants and lose every other expired session.
    expect(statement.text).toMatch(/SELECT [^;]*FROM expired WHERE EXISTS \(SELECT 1 FROM expired\)/);
    expect(statement.text).toContain("expired.id::text");
    // The trail projection fans out the SAME way — one row of the sweep, one upserted trail row —
    // and each row's stamp is correlated by SUBJECT, never by position: sibling data-modifying CTEs
    // execute in an unspecified order, so "the lower event id is the first row" is not a fact this
    // statement establishes.
    expect(statement.text).toContain("FROM expired s");
    expect(statement.text).toContain("(SELECT ev.id FROM ev_0 ev WHERE ev.subject_id = s.id)::bigint");
    assertPlaceholdersBind(statement);
  });

  it("renders no event machinery at all when no events are supplied", async () => {
    await expireStalePendingSessions(1000);
    const statement = onlyStatement();
    expect(statement.text).not.toContain("INSERT INTO events");
    assertPlaceholdersBind(statement);
  });
});

/**
 * **The transitional trail row is a CTE of the emitting statement** (u3d fix round, finding 2).
 *
 * Until that round every producer committed its mutation and its event and then called the
 * best-effort `recordPlayground*ActivityEvent` wrapper as a SECOND auto-committed statement whose
 * failure is swallowed — so a crash or an upsert error in the gap left the event committed with no
 * legacy projection, the drain stamped `legacy_missing`, and because `shadow` writes only
 * diagnostics nothing ever wrote the public row. That contradicted CLAUDE.md outright.
 *
 * These are properties of the rendered SQL, so they are checked here on every `npm test`: ONE
 * statement per producer, the projection reading the MUTATING CTE (never the table, whose snapshot
 * predates the mutation), and the `source_event_id` read straight out of the event arm.
 */
describe("every producer writes its trail row INSIDE its own statement", () => {
  /**
   * Per producer: the mutating CTE its projection must read, the `RETURNING` that CTE must carry so
   * the projection can read the POST-mutation row, the `source_event_id` expression it stamps, and
   * how the call is provoked.
   */
  const producers: Array<[string, string, string, string, () => Promise<unknown>]> = [
    [
      "createPlaygroundSession",
      "created",
      "RETURNING *",
      "(SELECT id FROM ev_0)::bigint",
      () =>
        createPlaygroundSession(
          {
            id: "sess_1",
            gameId: "pub-debate",
            participants: [],
            maxRounds: 6,
            currentRound: 0,
            status: "pending",
            schoolId: "foundation",
          },
          [playgroundSessionCreatedEvent({ actorAgentId: "agent_1", schoolId: "foundation" })]
        ).catch(() => undefined),
    ],
    [
      "cancelPlaygroundSession",
      "cancelled",
      "RETURNING *",
      "(SELECT id FROM ev_0)::bigint",
      () =>
        cancelPlaygroundSession("sess_1", "agent_1", "done", [
          sessionEvent("playground.session_cancelled"),
        ]),
    ],
    [
      "completePlaygroundSessionAtLifetimeCap",
      "capped",
      "RETURNING *",
      "(SELECT id FROM ev_0)::bigint",
      () =>
        completePlaygroundSessionAtLifetimeCap(
          "sess_1",
          { summary: "capped", completedAt: new Date().toISOString() },
          [
            playgroundSessionCompletedEvent({
              sessionId: "sess_1",
              schoolId: "foundation",
              reason: "lifetime_cap",
            }),
          ]
        ),
    ],
    [
      "expireStalePendingSessions",
      "expired",
      "RETURNING *",
      "(SELECT ev.id FROM ev_0 ev WHERE ev.subject_id = s.id)::bigint",
      () => expireStalePendingSessions(1000, [playgroundSessionExpiredEvent()]),
    ],
    [
      "joinPlaygroundSessionWithOutcome",
      "written",
      "RETURNING ps.*, pl.do_append",
      "COALESCE((SELECT id FROM joined_ev_0), (SELECT id FROM affiliation_ev_0))::bigint",
      () =>
        joinPlaygroundSessionWithOutcome(
          "sess_1",
          { agentId: "agent_1", agentName: "A", status: "active" },
          5,
          {
            joined: [sessionEvent("playground.session_joined")],
            affiliationUpdated: [
              {
                ...sessionEvent("playground.participant_affiliation_updated"),
                payload: { fields: [STORE_ASSIGNED_PAYLOAD_ID] },
              } as PreparedEvent,
            ],
          }
        ),
    ],
    [
      "applyPlaygroundResolution",
      "advanced",
      "RETURNING *",
      "(SELECT id FROM ev_0)::bigint",
      () =>
        applyPlaygroundResolution(
          "sess_1",
          { round: 2, token: "tok" },
          { status: "completed", summary: "done", completedAt: new Date().toISOString() },
          [],
          [sessionEvent("playground.session_completed")]
        ).catch(() => undefined),
    ],
  ];

  it.each(producers)(
    "%s projects the trail row from its own %s CTE, stamped by its event arm",
    async (_name, mutatingCte, returning, stamp, run) => {
      await run();

      // The DECISIVE statement is the first one; the only later statements any of these make are
      // documented advisory classification re-reads.
      const statement = captured[0];
      expect(statement.text).toContain("trail_projected AS (");
      expect(statement.text).toContain("INSERT INTO activity_events");
      // The row source is the MUTATING CTE. Reading `playground_sessions` here would take the
      // statement's own snapshot — the pre-mutation values — so a cancelled session's trail row
      // would still say 'active'.
      expect(statement.text).toMatch(new RegExp(`FROM ${mutatingCte} (s|pa)\\b`));
      // ...which means that CTE must return the whole row, not just its id. Asserted on the FIRST
      // `RETURNING` after the CTE opens, so a later sibling's cannot stand in for it.
      expect(statement.text).toMatch(
        new RegExp(`${mutatingCte} AS \\((?:(?!RETURNING)[\\s\\S])*${returning.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)
      );
      // The stamp comes out of the event arm rendered into this same statement — the only place the
      // id and the write exist together. The expiry sweep's is correlated per row, by subject.
      expect(statement.text).toContain(stamp);
      expect(statement.text).toContain("source_event_id = EXCLUDED.source_event_id");
      // The cached contexts go with the row, gated on what the upsert actually wrote: a write the
      // monotonic guard refused belongs to a NEWER event and its cache is still current.
      expect(statement.text).toContain("trail_uncached AS (");
      expect(statement.text).toContain("AND activity_id IN (SELECT entity_id FROM trail_projected)");
      assertPlaceholdersBind(statement);
    }
  );

  it("splices the ACTION projection into the gated insert, reading the inserted row", async () => {
    await submitPlaygroundActionGated(
      { id: "act_1", sessionId: "sess_1", agentId: "agent_1", round: 2, content: "move" },
      [
        {
          ...sessionEvent("playground.action_submitted"),
          idemKey: "playground_action:sess_1:2:agent_1",
          payload: { session_id: "sess_1", round: 2, agent_id: "agent_1" },
        } as PreparedEvent,
      ]
    );

    const statement = captured[0];
    expect(statement.text).toContain("trail_projected AS (");
    expect(statement.text).toContain("FROM inserted pa");
    expect(statement.text).toContain("activity_kind = 'playground_action'");
    // The duplicate-race loser inserts nothing, so `inserted` is empty and neither the event nor the
    // trail row exists — the projection is gated by its own row source.
    expect(statement.text.indexOf("ON CONFLICT (session_id, agent_id, round) DO NOTHING")).toBeLessThan(
      statement.text.indexOf("INSERT INTO activity_events")
    );
    assertPlaceholdersBind(statement);
  });

  it("writes no trail projection at all when the caller supplies no events", async () => {
    // A producer given no event still projects its row — that is the pre-u3d contract for fixtures
    // and seeds — but with NO `source_event_id`, so nothing claims a stamp it does not have.
    await expireStalePendingSessions(1000);
    const statement = onlyStatement();
    expect(statement.text).toContain("trail_projected AS (");
    expect(statement.text).not.toContain("source_event_id");
    assertPlaceholdersBind(statement);
  });

  /**
   * **A caller that renders only ONE of the join's two arms stamps neither.**
   *
   * The stamp is a COALESCE over the arms, so the branch WITHOUT an arm would write a NULL
   * `source_event_id` — and the monotonic guard compares `<= NULL`, which is NULL, so an existing
   * trail row would silently not refresh at all. A partial caller therefore gets the pre-stamp
   * behaviour, a plain upsert, rather than a lost projection. Production supplies both arms.
   */
  it("declines to stamp when only one of the join's two arms is rendered", async () => {
    await joinPlaygroundSessionWithOutcome(
      "sess_1",
      { agentId: "agent_1", agentName: "A", status: "active" },
      5,
      { joined: [sessionEvent("playground.session_joined")] }
    );

    const statement = onlyStatement();
    // The event arm is still rendered and still gated — only the PROJECTION's watermark is dropped.
    expect(statement.text).toContain("joined_ev_0 AS (");
    expect(statement.text).toContain("trail_projected AS (");
    expect(statement.text).not.toContain("source_event_id");
    assertPlaceholdersBind(statement);
  });

  it("stamps the join's trail row from WHICHEVER branch fired", async () => {
    await joinPlaygroundSessionWithOutcome(
      "sess_1",
      { agentId: "agent_1", agentName: "A", status: "active", actingAsLabel: "Acme" },
      5,
      {
        joined: [sessionEvent("playground.session_joined")],
        affiliationUpdated: [
          {
            ...sessionEvent("playground.participant_affiliation_updated"),
            payload: { fields: [STORE_ASSIGNED_PAYLOAD_ID] },
          } as PreparedEvent,
        ],
      }
    );

    const statement = onlyStatement();
    // The two arms are mutually exclusive branches of ONE `UPDATE`, so exactly one produced a row
    // and the first non-null read is that event's id. One projection serves both.
    expect(statement.text).toContain(
      "COALESCE((SELECT id FROM joined_ev_0), (SELECT id FROM affiliation_ev_0))::bigint"
    );
    expect(statement.text.match(/trail_projected AS \(/g)).toHaveLength(1);
    assertPlaceholdersBind(statement);
  });
});

describe("the join statement is ONE statement with TWO independently gated branches", () => {
  it("gates the join event on the append branch and the affiliation event on the merge branch", async () => {
    await joinPlaygroundSessionWithOutcome(
      "sess_1",
      { agentId: "agent_1", agentName: "A", status: "active", actingAsLabel: "Acme" },
      5,
      {
        joined: [sessionEvent("playground.session_joined")],
        affiliationUpdated: [
          {
            ...sessionEvent("playground.participant_affiliation_updated"),
            payload: { fields: [STORE_ASSIGNED_PAYLOAD_ID] },
          } as PreparedEvent,
        ],
      }
    );

    const statement = onlyStatement();
    // ONE statement — the whole point of the restructure. Two would be the racy pair it replaced.
    expect(captured).toHaveLength(1);
    // Two renders, distinct prefixes, distinct gates.
    expect(statement.text).toContain("WHERE EXISTS (SELECT 1 FROM appended)");
    expect(statement.text).toContain("WHERE EXISTS (SELECT 1 FROM refreshed)");
    // Distinct CTE prefixes: names restart at 0 on every render, so a shared prefix would define
    // `ev_0` twice in one `WITH` list and the statement would not parse at all.
    expect(statement.text).toContain("joined_ev_0 AS (");
    expect(statement.text).toContain("affiliation_ev_0 AS (");
    // Mutually exclusive by construction: one UPDATE, one CASE, and the two gates read its two arms.
    expect(statement.text).toContain("WHERE ps.id = pl.id AND (pl.do_append OR pl.do_merge)");
    expect(statement.text).toContain("appended AS (SELECT id FROM written WHERE do_append)");
    expect(statement.text).toContain("refreshed AS (SELECT id FROM written WHERE NOT do_append)");
    // The array is serialised by the row lock, not by a pre-read.
    expect(statement.text).toContain("FOR UPDATE");
    // The affiliation payload's `fields` is filled from the statement's own diff, so the action's
    // marker never reaches the row.
    expect(statement.text).toContain("jsonb_agg(src.field ORDER BY src.field)");
    assertPlaceholdersBind(statement);
  });

  it("renders nothing event-shaped when the caller supplies no events", async () => {
    await joinPlaygroundSessionWithOutcome(
      "sess_1",
      { agentId: "agent_1", agentName: "A", status: "active" },
      5
    );
    const statement = onlyStatement();
    expect(statement.text).not.toContain("INSERT INTO events");
    assertPlaceholdersBind(statement);
  });
});
