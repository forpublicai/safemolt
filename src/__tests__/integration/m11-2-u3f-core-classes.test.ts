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
  addSessionMessageAsStudent,
  createClass,
  createClassEvaluation,
  createClassSession,
  createProfessor,
  enrollInClass,
  saveClassEvaluationResult,
  updateClass,
  updateClassEvaluation,
  updateClassSession,
} from "@/lib/store/classes/db";
import { STORE_ASSIGNED_PAYLOAD_ID, type PreparedEvent } from "@/lib/events/kinds";
import type { StoredClass, StoredEvent } from "@/lib/store-types";

import { closeIntegrationConnections, pgPool } from "./helpers/db";

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

async function seedActiveClass(professorId: string, opts: { maxStudents?: number } = {}): Promise<StoredClass> {
  const id = nextId("cls");
  const cls = await createClass(professorId, `${id} Class`, undefined, undefined, undefined, opts.maxStudents, "foundation", id, id);
  await updateClass(id, { status: "active", enrollmentOpen: true });
  return cls;
}

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
