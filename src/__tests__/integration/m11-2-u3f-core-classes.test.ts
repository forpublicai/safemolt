/**
 * M11-2 u3f-core (P1.4) CLASSES `[integration]` — the gated class producers against a real Postgres.
 *
 * The memory-mode coupling suite proves the branch decisions with a hand-rolled fake. Only this one
 * can prove the guarantees are properties of SQL:
 *
 *  - each producer's write and its event are ONE statement — an injected event-insert failure rolls
 *    the write back and emits nothing;
 *  - the **enrollment capacity gate holds in SQL** — the last seat, taken under a class row lock,
 *    refuses the next enrollment without writing a row or emitting `class.enrolled`;
 *  - a **message to a completed session writes nothing and emits nothing**, and so does a submission
 *    to a closed evaluation;
 *  - and each committed producer emits exactly one event carrying the resolved id, never the
 *    store-assigned marker.
 *
 * Every fixture value is RUN-suffixed under every UNIQUE column: the reserved database persists rows
 * across runs.
 *
 * @jest-environment node
 */
import {
  addClassAssistant,
  addSessionMessageAsStudent,
  createClass,
  createClassEvaluation,
  createClassSession,
  createProfessor,
  dropClass,
  enrollInClass,
  saveClassEvaluationResult,
  updateClass,
  updateClassEvaluation,
  updateClassSession,
} from "@/lib/store/classes/db";
import { STORE_ASSIGNED_PAYLOAD_ID, type PreparedEvent } from "@/lib/events/kinds";
import type { StoredClass, StoredEvent } from "@/lib/store-types";

import { closeIntegrationConnections, pgClient, pgPool } from "./helpers/db";
import { raceAgainstHeldLock } from "./helpers/concurrency";
import { POST as postSessionMessage } from "@/app/api/v1/classes/[id]/sessions/[sessionId]/messages/route";

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
let seq = 0;
const nextId = (kind: string) => `u3fcl${kind}${RUN}${(seq += 1)}`;
let baselineEventId = 0;

async function seedAgent(): Promise<string> {
  const id = nextId("agent");
  await pgPool().query(
    `INSERT INTO agents (id, name, api_key, points, vote_points, evaluation_points,
                         legacy_unattributed_points, follower_count, is_claimed, created_at, is_vetted)
     VALUES ($1, $2, $3, 0, 0, 0, 0, 0, false, NOW(), true)`,
    [id, `${id}named`, `u3fclkey${id}`]
  );
  return id;
}

async function seedProfessor(): Promise<string> {
  const id = nextId("prof");
  await createProfessor(`${id}named`, `${id}@ex.test`, `u3fclprofkey${id}`, id);
  return id;
}

async function seedActiveClass(professorId: string, opts: { maxStudents?: number; schoolId?: string } = {}): Promise<StoredClass> {
  const id = nextId("cls");
  const cls = await createClass(professorId, `${id} Class`, undefined, undefined, undefined, opts.maxStudents, opts.schoolId ?? "foundation", id, id);
  await updateClass(id, { status: "active", enrollmentOpen: true });
  return cls;
}

/** Seed a vetted agent whose api key is recoverable (`apiKeyFor`) — for the route actor branches. */
const apiKeyFor = (agentId: string) => `u3fclkey${agentId}`;
const professorKeyFor = (professorId: string) => `u3fclprofkey${professorId}`;

async function seedSession(classId: string, status: "active" | "completed"): Promise<string> {
  const session = await createClassSession(classId, "Session", "lecture", undefined, 1);
  await updateClassSession(session.id, { status });
  return session.id;
}

async function seedEvaluation(classId: string, status: "active" | "draft"): Promise<string> {
  const ev = await createClassEvaluation(classId, "Eval", "Prompt", undefined, undefined, 10, "automatic");
  if (status === "active") await updateClassEvaluation(ev.id, { status: "active" });
  return ev.id;
}

function enrolledEvent(agentId: string, classId: string): PreparedEvent<"class.enrolled"> {
  return { kind: "class.enrolled", actorAgentId: agentId, subjectType: "class_enrollment", subjectId: STORE_ASSIGNED_PAYLOAD_ID, schoolId: "foundation", payload: { class_id: classId } };
}
function messageEvent(agentId: string, sessionId: string): PreparedEvent<"class.session_message"> {
  return { kind: "class.session_message", actorAgentId: agentId, subjectType: "class_session", subjectId: sessionId, schoolId: "foundation", payload: { message_id: STORE_ASSIGNED_PAYLOAD_ID } };
}
function evalEvent(agentId: string, classId: string, evaluationId: string): PreparedEvent<"class.evaluation_submitted"> {
  return { kind: "class.evaluation_submitted", actorAgentId: agentId, subjectType: "class_evaluation_result", subjectId: STORE_ASSIGNED_PAYLOAD_ID, schoolId: "foundation", payload: { class_id: classId, evaluation_id: evaluationId, result_id: STORE_ASSIGNED_PAYLOAD_ID } };
}
function droppedEvent(agentId: string, classId: string): PreparedEvent<"class.dropped"> {
  return { kind: "class.dropped", actorAgentId: agentId, subjectType: "class_enrollment", subjectId: STORE_ASSIGNED_PAYLOAD_ID, schoolId: "foundation", payload: { class_id: classId } };
}

async function totalEnrollments(classId: string): Promise<number> {
  const { rows } = await pgPool().query(
    `SELECT count(*)::int AS c FROM class_enrollments WHERE class_id = $1 AND status <> 'dropped'`,
    [classId]
  );
  return rows[0].c;
}

async function enrollmentStatus(classId: string, agentId: string): Promise<string | null> {
  const { rows } = await pgPool().query(
    `SELECT status FROM class_enrollments WHERE class_id = $1 AND agent_id = $2 LIMIT 1`,
    [classId, agentId]
  );
  return rows[0]?.status ?? null;
}

/** A message-route POST with a bearer credential and the middleware-injected school header. */
function messageRequest(classId: string, sessionId: string, apiKey: string, content = "hello", schoolId = "foundation"): Request {
  return new Request(`https://safe.test/api/v1/classes/${classId}/sessions/${sessionId}/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
      "x-school-id": schoolId,
    },
    body: JSON.stringify({ content }),
  });
}

function messageRouteParams(classId: string, sessionId: string) {
  return { params: Promise.resolve({ id: classId, sessionId }) };
}

async function eventsSince(kind?: string): Promise<StoredEvent[]> {
  const { rows } = await pgPool().query(
    kind === undefined
      ? `SELECT id, kind, actor_agent_id, subject_type, subject_id, school_id, payload FROM events WHERE id > $1 ORDER BY id`
      : `SELECT id, kind, actor_agent_id, subject_type, subject_id, school_id, payload FROM events WHERE id > $1 AND kind = $2 ORDER BY id`,
    kind === undefined ? [baselineEventId] : [baselineEventId, kind]
  );
  return rows.map((row: Record<string, unknown>) => ({
    id: Number(row.id),
    kind: String(row.kind),
    actorAgentId: (row.actor_agent_id as string) ?? null,
    subjectType: (row.subject_type as string) ?? null,
    subjectId: (row.subject_id as string) ?? null,
    secondarySubjectId: null,
    schoolId: (row.school_id as string) ?? null,
    idemKey: null,
    payload: row.payload as Record<string, unknown>,
    createdAt: "",
  }));
}

/** Fail every event insert of one kind, so the mutation's own rollback can be observed. */
async function withEventFailure<T>(kind: string, run: () => Promise<T>): Promise<T> {
  const suffix = `${RUN}_${++seq}`;
  const functionName = `u3fcl_fail_${suffix}`;
  const triggerName = `u3fcl_fail_trigger_${suffix}`;
  await pgPool().query(`
    CREATE OR REPLACE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
      IF NEW.kind = '${kind}' THEN RAISE EXCEPTION 'u3fcl injected ${kind} failure'; END IF;
      RETURN NEW;
    END; $fn$;
  `);
  await pgPool().query(`CREATE TRIGGER ${triggerName} AFTER INSERT ON events FOR EACH ROW EXECUTE FUNCTION ${functionName}()`);
  try {
    return await run();
  } finally {
    await pgPool().query(`DROP TRIGGER IF EXISTS ${triggerName} ON events`);
    await pgPool().query(`DROP FUNCTION IF EXISTS ${functionName}()`);
  }
}

async function enrollmentRowCount(classId: string, agentId: string): Promise<number> {
  const { rows } = await pgPool().query(
    `SELECT count(*)::int AS c FROM class_enrollments WHERE class_id = $1 AND agent_id = $2 AND status <> 'dropped'`,
    [classId, agentId]
  );
  return rows[0].c;
}

beforeEach(async () => {
  const { rows } = await pgPool().query(`SELECT COALESCE(MAX(id), 0)::bigint AS id FROM events`);
  baselineEventId = Number(rows[0].id);
});

afterEach(async () => {
  for (const event of await eventsSince()) {
    expect(JSON.stringify(event.payload)).not.toContain(STORE_ASSIGNED_PAYLOAD_ID);
    expect(event.subjectId).not.toBe(STORE_ASSIGNED_PAYLOAD_ID);
  }
});

afterAll(async () => {
  await closeIntegrationConnections();
});

describe("enrollment couples its event and enforces capacity in SQL", () => {
  it("emits one class.enrolled carrying the enrollment id, not the marker", async () => {
    const prof = await seedProfessor();
    const cls = await seedActiveClass(prof);
    const agentId = await seedAgent();

    const outcome = await enrollInClass(cls.id, agentId, [enrolledEvent(agentId, cls.id)]);

    expect(outcome.enrollment).not.toBeNull();
    const emitted = await eventsSince("class.enrolled");
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ actorAgentId: agentId, subjectType: "class_enrollment", subjectId: outcome.enrollment!.id, payload: { class_id: cls.id } });
  });

  it("refuses the seat over capacity, writing no row and emitting nothing", async () => {
    const prof = await seedProfessor();
    const cls = await seedActiveClass(prof, { maxStudents: 1 });
    const first = await seedAgent();
    const second = await seedAgent();

    const firstOutcome = await enrollInClass(cls.id, first, [enrolledEvent(first, cls.id)]);
    expect(firstOutcome.enrollment).not.toBeNull();

    baselineEventId = Number((await pgPool().query(`SELECT COALESCE(MAX(id), 0)::bigint AS id FROM events`)).rows[0].id);
    const secondOutcome = await enrollInClass(cls.id, second, [enrolledEvent(second, cls.id)]);

    expect(secondOutcome.enrollment).toBeNull();
    expect(secondOutcome.atCapacity).toBe(true);
    expect(await enrollmentRowCount(cls.id, second)).toBe(0);
    expect(await eventsSince()).toEqual([]);
  });

  it("rolls the enrollment back when its event cannot be written", async () => {
    const prof = await seedProfessor();
    const cls = await seedActiveClass(prof);
    const agentId = await seedAgent();

    await withEventFailure("class.enrolled", async () => {
      await expect(enrollInClass(cls.id, agentId, [enrolledEvent(agentId, cls.id)])).rejects.toThrow(/injected/);
    });

    expect(await enrollmentRowCount(cls.id, agentId)).toBe(0);
    expect(await eventsSince()).toEqual([]);
  });
});

describe("student session message couples its event and gates on session + enrollment", () => {
  it("emits class.session_message for an enrolled student on an active session", async () => {
    const prof = await seedProfessor();
    const cls = await seedActiveClass(prof);
    const agentId = await seedAgent();
    await enrollInClass(cls.id, agentId);
    const sessionId = await seedSession(cls.id, "active");
    baselineEventId = Number((await pgPool().query(`SELECT COALESCE(MAX(id), 0)::bigint AS id FROM events`)).rows[0].id);

    const outcome = await addSessionMessageAsStudent(cls.id, sessionId, agentId, "hello", [messageEvent(agentId, sessionId)]);

    expect(outcome.message).not.toBeNull();
    const emitted = await eventsSince("class.session_message");
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ subjectType: "class_session", subjectId: sessionId, payload: { message_id: outcome.message!.id } });
  });

  it("writes nothing and emits nothing for a completed session", async () => {
    const prof = await seedProfessor();
    const cls = await seedActiveClass(prof);
    const agentId = await seedAgent();
    await enrollInClass(cls.id, agentId);
    const sessionId = await seedSession(cls.id, "completed");
    baselineEventId = Number((await pgPool().query(`SELECT COALESCE(MAX(id), 0)::bigint AS id FROM events`)).rows[0].id);

    const outcome = await addSessionMessageAsStudent(cls.id, sessionId, agentId, "hello", [messageEvent(agentId, sessionId)]);

    expect(outcome.message).toBeNull();
    expect(outcome.sessionActive).toBe(false);
    const { rows } = await pgPool().query(`SELECT count(*)::int AS c FROM class_session_messages WHERE session_id = $1`, [sessionId]);
    expect(rows[0].c).toBe(0);
    expect(await eventsSince()).toEqual([]);
  });

  it("rolls the message back when its event cannot be written", async () => {
    const prof = await seedProfessor();
    const cls = await seedActiveClass(prof);
    const agentId = await seedAgent();
    await enrollInClass(cls.id, agentId);
    const sessionId = await seedSession(cls.id, "active");

    await withEventFailure("class.session_message", async () => {
      await expect(addSessionMessageAsStudent(cls.id, sessionId, agentId, "hello", [messageEvent(agentId, sessionId)])).rejects.toThrow(/injected/);
    });

    const { rows } = await pgPool().query(`SELECT count(*)::int AS c FROM class_session_messages WHERE session_id = $1`, [sessionId]);
    expect(rows[0].c).toBe(0);
    expect(await eventsSince("class.session_message")).toEqual([]);
  });
});

describe("evaluation submission couples its event and gates on active + enrolled", () => {
  it("emits class.evaluation_submitted for an enrolled student on an active evaluation", async () => {
    const prof = await seedProfessor();
    const cls = await seedActiveClass(prof);
    const agentId = await seedAgent();
    await enrollInClass(cls.id, agentId);
    const evalId = await seedEvaluation(cls.id, "active");
    baselineEventId = Number((await pgPool().query(`SELECT COALESCE(MAX(id), 0)::bigint AS id FROM events`)).rows[0].id);

    const result = await saveClassEvaluationResult(evalId, agentId, "answer", undefined, 10, undefined, undefined, [evalEvent(agentId, cls.id, evalId)]);

    expect(result).not.toBeNull();
    const emitted = await eventsSince("class.evaluation_submitted");
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ subjectType: "class_evaluation_result", subjectId: result!.id, payload: { class_id: cls.id, evaluation_id: evalId, result_id: result!.id } });
  });

  it("writes nothing and emits nothing for a draft evaluation", async () => {
    const prof = await seedProfessor();
    const cls = await seedActiveClass(prof);
    const agentId = await seedAgent();
    await enrollInClass(cls.id, agentId);
    const evalId = await seedEvaluation(cls.id, "draft");
    baselineEventId = Number((await pgPool().query(`SELECT COALESCE(MAX(id), 0)::bigint AS id FROM events`)).rows[0].id);

    const result = await saveClassEvaluationResult(evalId, agentId, "answer", undefined, 10, undefined, undefined, [evalEvent(agentId, cls.id, evalId)]);

    expect(result).toBeNull();
    const { rows } = await pgPool().query(`SELECT count(*)::int AS c FROM class_evaluation_results WHERE evaluation_id = $1`, [evalId]);
    expect(rows[0].c).toBe(0);
    expect(await eventsSince()).toEqual([]);
  });

  it("writes nothing and emits nothing for a non-enrolled agent", async () => {
    const prof = await seedProfessor();
    const cls = await seedActiveClass(prof);
    const agentId = await seedAgent(); // never enrolled
    const evalId = await seedEvaluation(cls.id, "active");
    baselineEventId = Number((await pgPool().query(`SELECT COALESCE(MAX(id), 0)::bigint AS id FROM events`)).rows[0].id);

    const result = await saveClassEvaluationResult(evalId, agentId, "answer", undefined, 10, undefined, undefined, [evalEvent(agentId, cls.id, evalId)]);

    expect(result).toBeNull();
    expect(await eventsSince()).toEqual([]);
  });

  it("ungated professor grade (no events) still writes, and emits nothing", async () => {
    const prof = await seedProfessor();
    const cls = await seedActiveClass(prof);
    const agentId = await seedAgent();
    await enrollInClass(cls.id, agentId);
    const evalId = await seedEvaluation(cls.id, "active");
    // A student result exists to grade.
    await saveClassEvaluationResult(evalId, agentId, "answer", undefined, 10, undefined, undefined, [evalEvent(agentId, cls.id, evalId)]);
    baselineEventId = Number((await pgPool().query(`SELECT COALESCE(MAX(id), 0)::bigint AS id FROM events`)).rows[0].id);

    // Professor grade: no events -> ungated upsert, always returns the row, emits nothing.
    const graded = await saveClassEvaluationResult(evalId, agentId, undefined, 9, 10, undefined, "Good");
    expect(graded).not.toBeNull();
    expect(await eventsSince()).toEqual([]);
  });

  it("rolls the result back when its event cannot be written", async () => {
    const prof = await seedProfessor();
    const cls = await seedActiveClass(prof);
    const agentId = await seedAgent();
    await enrollInClass(cls.id, agentId);
    const evalId = await seedEvaluation(cls.id, "active");

    await withEventFailure("class.evaluation_submitted", async () => {
      await expect(saveClassEvaluationResult(evalId, agentId, "answer", undefined, 10, undefined, undefined, [evalEvent(agentId, cls.id, evalId)])).rejects.toThrow(/injected/);
    });

    const { rows } = await pgPool().query(`SELECT count(*)::int AS c FROM class_evaluation_results WHERE evaluation_id = $1`, [evalId]);
    expect(rows[0].c).toBe(0);
    expect(await eventsSince("class.evaluation_submitted")).toEqual([]);
  });
});

describe("drop couples its event and rolls back on an event-insert failure", () => {
  it("rolls the drop back when its event cannot be written", async () => {
    const prof = await seedProfessor();
    const cls = await seedActiveClass(prof);
    const agentId = await seedAgent();
    await enrollInClass(cls.id, agentId);
    expect(await enrollmentStatus(cls.id, agentId)).toBe("enrolled");

    await withEventFailure("class.dropped", async () => {
      await expect(dropClass(cls.id, agentId, [droppedEvent(agentId, cls.id)])).rejects.toThrow(/injected/);
    });

    // The enrollment is still enrolled — the UPDATE to 'dropped' rolled back with the failed event.
    expect(await enrollmentStatus(cls.id, agentId)).toBe("enrolled");
    expect(await eventsSince("class.dropped")).toEqual([]);
  });
});

describe("the enroll cap holds under a genuine two-connection race (R2-1)", () => {
  it("two concurrent enrollInClass race the class lock: exactly one enrolls and emits one class.enrolled", async () => {
    // maxStudents = 1, no seat taken yet. The R2-1 defect: a SINGLE statement takes one snapshot at
    // statement start, so BOTH contenders that block on the class `FOR UPDATE` still count the seat as
    // empty after the winner commits, and BOTH enrol and BOTH emit `class.enrolled`. The fix counts in
    // a LATER transaction element, taken on a FRESH snapshot after the wait ends, so the loser sees the
    // winner's committed seat and refuses. BOTH contenders are REAL enrollInClass calls, not a raw-SQL
    // seat: a raw-SQL winner emits nothing, so it can never prove the winning call ITSELF emits exactly
    // one event — a concurrency defect that suppressed the successful call's event would slip past.
    const prof = await seedProfessor();
    const cls = await seedActiveClass(prof, { maxStudents: 1 });
    const a1 = await seedAgent();
    const a2 = await seedAgent();

    baselineEventId = Number((await pgPool().query(`SELECT COALESCE(MAX(id), 0)::bigint AS id FROM events`)).rows[0].id);

    // Hold the class row FOR UPDATE, uncommitted, so both enrollments block on element 1 and can only
    // count on a fresh snapshot once released. A held pg transaction is the only real lock over the
    // Neon HTTP driver (see helpers/concurrency); wall-clock ordering is never the basis here.
    const holder = await pgClient();
    let settled: PromiseSettledResult<Awaited<ReturnType<typeof enrollInClass>>>[] = [];
    let blockedCount = 0;
    try {
      await holder.query("BEGIN");
      await holder.query(`SELECT id FROM classes WHERE id = $1 FOR UPDATE`, [cls.id]);

      const c1 = enrollInClass(cls.id, a1, [enrolledEvent(a1, cls.id)]);
      const c2 = enrollInClass(cls.id, a2, [enrolledEvent(a2, cls.id)]);
      const both = Promise.allSettled([c1, c2]);

      // Wait until BOTH enrollments are genuinely blocked (marker-scoped, from pg_blocking_pids),
      // never a sleep. PostgreSQL QUEUES row-lock waiters, so only the first is blocked directly by
      // the holder and the second is blocked by the first — so count marker-bearing backends that are
      // blocked by ANYONE, not only those blocked directly by the holder.
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const { rows } = await pgPool().query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_stat_activity
           WHERE datname = current_database() AND pid <> pg_backend_pid()
             AND cardinality(pg_blocking_pids(pid)) > 0
             AND query LIKE '%class:enroll-lock%'`
        );
        blockedCount = rows[0].n;
        if (blockedCount >= 2) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }

      await holder.query("COMMIT");
      settled = await both;
    } finally {
      await holder.end();
    }

    // The barrier genuinely engaged BOTH contenders on the class lock.
    expect(blockedCount).toBeGreaterThanOrEqual(2);

    // Neither call rejected; each returned an outcome.
    const outcomes = settled.map((s) => {
      if (s.status !== "fulfilled") throw s.reason;
      return s.value;
    });
    const winners = outcomes.filter((o) => o.enrollment !== null);
    const losers = outcomes.filter((o) => o.enrollment === null);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0]!.atCapacity).toBe(true);

    // Exactly one seat filled, and EXACTLY ONE class.enrolled event — the winning call's own write.
    // A suppressed-winner-event defect would show 0 here; a cap breach would show 2.
    expect(await totalEnrollments(cls.id)).toBe(1);
    const emitted = await eventsSince("class.enrolled");
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.actorAgentId).toBe(winners[0]!.enrollment!.agentId);
  });
});

describe("a student message races a concurrent session completion (R2-1)", () => {
  it("a completion committing during the message write leaves nothing written and nothing emitted", async () => {
    const prof = await seedProfessor();
    const cls = await seedActiveClass(prof);
    const agentId = await seedAgent();
    await enrollInClass(cls.id, agentId);
    const sessionId = await seedSession(cls.id, "active");

    baselineEventId = Number((await pgPool().query(`SELECT COALESCE(MAX(id), 0)::bigint AS id FROM events`)).rows[0].id);

    const outcome = await raceAgainstHeldLock({
      // Complete the session, uncommitted, holding the session row `FOR UPDATE`. The message's
      // `FOR SHARE` read blocks here; a bare snapshot read (the R2-1 defect) would see the pre-update
      // active row and let the message land on a session being completed.
      hold: async (holder) => {
        await holder.query(`UPDATE class_sessions SET status = 'completed', ended_at = NOW() WHERE id = $1`, [sessionId]);
      },
      contend: async () => await addSessionMessageAsStudent(cls.id, sessionId, agentId, "hello", [messageEvent(agentId, sessionId)]),
      contenderMarker: "class:msg-session-lock",
    });

    expect(outcome.result.message).toBeNull();
    expect(outcome.result.sessionActive).toBe(false);
    const { rows } = await pgPool().query(`SELECT count(*)::int AS c FROM class_session_messages WHERE session_id = $1`, [sessionId]);
    expect(rows[0].c).toBe(0);
    expect(await eventsSince("class.session_message")).toEqual([]);
    expect(outcome.observedBlocked).toBe(true);
  });
});

describe("the messages route renders the full 201 body for each actor branch, and gates the assistant on the school (R2-2)", () => {
  async function readBody(res: Response): Promise<Record<string, unknown>> {
    return (await res.json()) as Record<string, unknown>;
  }

  it("professor branch returns 201 with the operator message body (no event)", async () => {
    const prof = await seedProfessor();
    const cls = await seedActiveClass(prof);
    const sessionId = await seedSession(cls.id, "active");
    baselineEventId = Number((await pgPool().query(`SELECT COALESCE(MAX(id), 0)::bigint AS id FROM events`)).rows[0].id);

    const res = await postSessionMessage(
      messageRequest(cls.id, sessionId, professorKeyFor(prof)),
      messageRouteParams(cls.id, sessionId)
    );

    expect(res.status).toBe(201);
    const body = await readBody(res);
    expect(body).toMatchObject({
      success: true,
      data: {
        id: expect.any(String),
        sessionId,
        senderId: prof,
        senderRole: "professor",
        content: "hello",
        sequence: expect.any(Number),
        createdAt: expect.any(String),
      },
    });
    expect(await eventsSince("class.session_message")).toEqual([]);
  });

  it("agent teaching-assistant branch returns 201 with the ta message body and emits class.session_message (B3: TA emits)", async () => {
    const prof = await seedProfessor();
    const cls = await seedActiveClass(prof);
    const sessionId = await seedSession(cls.id, "active");
    const ta = await seedAgent();
    await addClassAssistant(cls.id, ta);
    baselineEventId = Number((await pgPool().query(`SELECT COALESCE(MAX(id), 0)::bigint AS id FROM events`)).rows[0].id);

    const res = await postSessionMessage(
      messageRequest(cls.id, sessionId, apiKeyFor(ta)),
      messageRouteParams(cls.id, sessionId)
    );

    expect(res.status).toBe(201);
    const body = await readBody(res);
    expect(body).toMatchObject({
      success: true,
      data: {
        id: expect.any(String),
        sessionId,
        senderId: ta,
        senderRole: "ta",
        content: "hello",
        sequence: expect.any(Number),
        createdAt: expect.any(String),
      },
    });
    // The TA now emits like a student (per the user's B3 decision), stamped with role `ta`.
    const emitted = await eventsSince("class.session_message");
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ subjectType: "class_session", subjectId: sessionId, actorAgentId: ta });
  });

  it("student branch returns 201 with the emitted student message body and emits class.session_message", async () => {
    const prof = await seedProfessor();
    const cls = await seedActiveClass(prof);
    const sessionId = await seedSession(cls.id, "active");
    const student = await seedAgent();
    await enrollInClass(cls.id, student);
    baselineEventId = Number((await pgPool().query(`SELECT COALESCE(MAX(id), 0)::bigint AS id FROM events`)).rows[0].id);

    const res = await postSessionMessage(
      messageRequest(cls.id, sessionId, apiKeyFor(student)),
      messageRouteParams(cls.id, sessionId)
    );

    expect(res.status).toBe(201);
    const body = await readBody(res);
    expect(body).toMatchObject({
      success: true,
      data: {
        id: expect.any(String),
        sessionId,
        senderId: student,
        senderRole: "student",
        content: "hello",
        sequence: expect.any(Number),
        createdAt: expect.any(String),
      },
    });
    const emitted = await eventsSince("class.session_message");
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ subjectType: "class_session", subjectId: sessionId });
  });

  it("refuses an unadmitted agent teaching-assistant on a non-Foundation class (the R2-2 bypass)", async () => {
    // The class belongs to another school; the assistant is vetted (so `requireAgent` passes on the
    // Foundation host) but not admitted to that school. Before R2-2 the TA branch wrote the message
    // with no school check; now it must answer 403 admission_required.
    const savedGate = process.env.ADMISSIONS_GATE_DISABLED;
    delete process.env.ADMISSIONS_GATE_DISABLED;
    try {
      const prof = await seedProfessor();
      const schoolId = `u3fclschool${RUN}`;
      const cls = await seedActiveClass(prof, { schoolId });
      const sessionId = await seedSession(cls.id, "active");
      const ta = await seedAgent(); // vetted, not admitted
      await addClassAssistant(cls.id, ta);
      baselineEventId = Number((await pgPool().query(`SELECT COALESCE(MAX(id), 0)::bigint AS id FROM events`)).rows[0].id);

      // The request reaches the Foundation host (x-school-id: foundation), so `requireAgent` passes
      // on the weaker rule; the class's own school is what must refuse.
      const res = await postSessionMessage(
        messageRequest(cls.id, sessionId, apiKeyFor(ta), "hello", "foundation"),
        messageRouteParams(cls.id, sessionId)
      );

      expect(res.status).toBe(403);
      const body = await readBody(res);
      expect(body).toMatchObject({ success: false, admission_required: true });
      const { rows } = await pgPool().query(`SELECT count(*)::int AS c FROM class_session_messages WHERE session_id = $1`, [sessionId]);
      expect(rows[0].c).toBe(0);
      expect(await eventsSince()).toEqual([]);
    } finally {
      if (savedGate === undefined) delete process.env.ADMISSIONS_GATE_DISABLED;
      else process.env.ADMISSIONS_GATE_DISABLED = savedGate;
    }
  });
});
