/**
 * M11-2 u3f-core (P1.4) CLASSES — the Tier-1 coupling and the B3 assistant split.
 *
 * Classes are Postgres-only, so there is no memory twin to drive. "Memory mode" here is a
 * hand-rolled fake `@/lib/store` that MIRRORS each decisive statement: it applies the same
 * in-statement gate (M4) and pushes the prepared events onto `emitted` ONLY when the gated write
 * commits. That makes two properties assertable without a database:
 *
 *  - **no write without its event, no event without its write** — a refused or no-op mutation
 *    (class full, not enrolled, session/evaluation not active, already enrolled, a drop of a
 *    non-enrolled agent) commits nothing and emits nothing;
 *  - **the action reaches the statement rather than a pre-read** (M4) — the enroll and message
 *    actions no longer read the seat count or the enrollment to refuse; they classify from the
 *    outcome flags the write returned. The mutation-check is the assertion that those pre-reads are
 *    never called, which fails on the pre-fix action that made them.
 *
 * The **assistant split (B3)** lives in the messages ROUTE, so it is exercised there: a professor
 * and an agent teaching-assistant are routed to the operator writer (history-silent), while an
 * enrolled student goes through the action and emits `class.session_message`.
 *
 * @jest-environment node
 */
import { STORE_ASSIGNED_PAYLOAD_ID } from "@/lib/events/kinds";
import type {
  PreparedEvent,
} from "@/lib/events/kinds";
import type {
  StoredAgent,
  StoredClass,
  StoredClassEnrollment,
  StoredClassEvaluation,
  StoredClassSession,
} from "@/lib/store-types";

let seq = 0;
const nextId = (label: string) => `u3fcore${label}${(seq += 1)}`;

interface FakeState {
  classes: Map<string, StoredClass>;
  enrollments: Map<string, StoredClassEnrollment>;
  sessions: Map<string, StoredClassSession>;
  evals: Map<string, StoredClassEvaluation>;
  assistants: Set<string>;
  emitted: PreparedEvent[];
  calls: string[];
}

function freshState(): FakeState {
  return {
    classes: new Map(),
    enrollments: new Map(),
    sessions: new Map(),
    evals: new Map(),
    assistants: new Set(),
    emitted: [],
    calls: [],
  };
}

const key = (classId: string, agentId: string) => `${classId}:${agentId}`;

/** A fake `@/lib/store` whose writers gate exactly as the SQL statements do and emit only on commit. */
function makeStore(s: FakeState) {
  const enrolledCount = (classId: string) =>
    [...s.enrollments.values()].filter(
      (e) => e.classId === classId && (e.status === "enrolled" || e.status === "active")
    ).length;

  return {
    getClassById: jest.fn(async (id: string) => s.classes.get(id) ?? null),
    getClassEnrollment: jest.fn(async (classId: string, agentId: string) => {
      s.calls.push("getClassEnrollment");
      return s.enrollments.get(key(classId, agentId)) ?? null;
    }),
    getClassEnrollmentCount: jest.fn(async (classId: string) => {
      s.calls.push("getClassEnrollmentCount");
      return enrolledCount(classId);
    }),
    getClassSession: jest.fn(async (id: string) => s.sessions.get(id) ?? null),
    getClassEvaluation: jest.fn(async (id: string) => s.evals.get(id) ?? null),
    isClassAssistant: jest.fn(async (classId: string, agentId: string) => s.assistants.has(key(classId, agentId))),

    enrollInClass: jest.fn(async (classId: string, agentId: string, events?: readonly PreparedEvent[]) => {
      const cls = s.classes.get(classId);
      if (!cls) return { enrollment: null, classPresent: false, isOpen: false, isActive: false, already: false, atCapacity: false };
      const existing = s.enrollments.get(key(classId, agentId));
      const already = !!existing && existing.status !== "dropped";
      const atCapacity = cls.maxStudents != null && enrolledCount(classId) >= cls.maxStudents;
      const isOpen = !!cls.enrollmentOpen;
      const isActive = cls.status === "active";
      if (isOpen && isActive && !already && !atCapacity) {
        const row: StoredClassEnrollment = { id: `enrl_${agentId}`, classId, agentId, status: "enrolled", enrolledAt: "t" };
        s.enrollments.set(key(classId, agentId), row);
        if (events) s.emitted.push(...events);
        return { enrollment: row, classPresent: true, isOpen, isActive, already, atCapacity };
      }
      return { enrollment: null, classPresent: true, isOpen, isActive, already, atCapacity };
    }),

    dropClass: jest.fn(async (classId: string, agentId: string, events?: readonly PreparedEvent[]) => {
      const existing = s.enrollments.get(key(classId, agentId));
      if (existing && (existing.status === "enrolled" || existing.status === "active")) {
        existing.status = "dropped";
        if (events) s.emitted.push(...events);
        return true;
      }
      return false;
    }),

    addSessionMessageAsStudent: jest.fn(
      async (classId: string, sessionId: string, agentId: string, content: string, events?: readonly PreparedEvent[]) => {
        const sess = s.sessions.get(sessionId);
        const sessionActive = sess?.status === "active";
        const enr = s.enrollments.get(key(classId, agentId));
        const enrolled = !!enr && enr.status !== "dropped";
        const isAssistant = s.assistants.has(key(classId, agentId));
        if (sessionActive && (enrolled || isAssistant)) {
          if (events) s.emitted.push(...events);
          return {
            message: { id: `cmsg_${agentId}`, sessionId, senderId: agentId, senderRole: isAssistant ? ("ta" as const) : ("student" as const), content, sequence: 1, createdAt: "t" },
            sessionActive: true,
            enrolled,
            isAssistant,
          };
        }
        return { message: null, sessionActive: !!sessionActive, enrolled, isAssistant };
      }
    ),

    saveClassEvaluationResult: jest.fn(
      async (
        evaluationId: string,
        agentId: string,
        response?: string,
        score?: number,
        maxScore?: number,
        resultData?: Record<string, unknown>,
        feedback?: string,
        events?: readonly PreparedEvent[]
      ) => {
        if (events && events.length) {
          const ev = s.evals.get(evaluationId);
          const evalActive = ev?.status === "active";
          const enr = ev ? s.enrollments.get(key(ev.classId, agentId)) : undefined;
          const enrolled = !!enr && enr.status !== "dropped";
          if (!(evalActive && enrolled)) return null;
          s.emitted.push(...events);
        }
        return { id: `cres_${agentId}`, evaluationId, agentId, response, score, maxScore, resultData, feedback, completedAt: "t" };
      }
    ),

    // Operator writer, used by class-ops for the professor/TA branch — never emits.
    addClassSessionMessage: jest.fn(async (sessionId: string, senderId: string, senderRole: string, content: string) => ({
      id: `cmsg_op_${senderId}`,
      sessionId,
      senderId,
      senderRole,
      content,
      sequence: 1,
      createdAt: "t",
    })),
  };
}

function agent(overrides: Partial<StoredAgent> = {}): StoredAgent {
  const id = overrides.id ?? nextId("ag");
  return { id, name: id, apiKey: `k_${id}`, isVetted: true, isAdmitted: true, ...overrides } as StoredAgent;
}

function seedClass(s: FakeState, overrides: Partial<StoredClass> = {}): StoredClass {
  const id = overrides.id ?? nextId("cls");
  const cls: StoredClass = {
    id,
    slug: id,
    schoolId: "foundation",
    professorId: "prof",
    name: "Class",
    status: "active",
    enrollmentOpen: true,
    createdAt: "t",
    ...overrides,
  };
  s.classes.set(cls.id, cls);
  return cls;
}

function enrol(s: FakeState, classId: string, agentId: string, status: StoredClassEnrollment["status"] = "enrolled") {
  s.enrollments.set(key(classId, agentId), { id: `enrl_${agentId}`, classId, agentId, status, enrolledAt: "t" });
}

/** Load the real actions against a fake store built from `state`. */
async function loadActions(state: FakeState) {
  jest.resetModules();
  jest.doMock("@/lib/store", () => makeStore(state));
  return import("@/lib/actions/classes");
}

describe("enroll — capacity, status and duplicate gated in the write (M4)", () => {
  it("emits class.enrolled on a committed enrollment, with the class in the payload", async () => {
    const state = freshState();
    const cls = seedClass(state);
    const { enroll } = await loadActions(state);
    const a = agent();

    const result = await enroll({ agent: a, classId: cls.id });

    expect(result.ok).toBe(true);
    expect(state.emitted).toHaveLength(1);
    expect(state.emitted[0]).toMatchObject({
      kind: "class.enrolled",
      actorAgentId: a.id,
      subjectType: "class_enrollment",
      subjectId: STORE_ASSIGNED_PAYLOAD_ID,
      schoolId: "foundation",
      payload: { class_id: cls.id },
    });
  });

  it("refuses an over-capacity enrollment and emits nothing", async () => {
    const state = freshState();
    const cls = seedClass(state, { maxStudents: 1 });
    enrol(state, cls.id, "occupant"); // the one seat
    const { enroll } = await loadActions(state);

    const result = await enroll({ agent: agent(), classId: cls.id });

    expect(result).toMatchObject({ ok: false, code: "bad_request", message: "Class is full" });
    expect(state.emitted).toEqual([]);
  });

  it("refuses a duplicate enrollment and emits nothing", async () => {
    const state = freshState();
    const cls = seedClass(state);
    const a = agent();
    enrol(state, cls.id, a.id);
    const { enroll } = await loadActions(state);

    const result = await enroll({ agent: a, classId: cls.id });

    expect(result).toMatchObject({ ok: false, code: "bad_request", message: "Already enrolled in this class" });
    expect(state.emitted).toEqual([]);
  });

  it("refuses a closed or inactive class and emits nothing", async () => {
    const state = freshState();
    const closed = seedClass(state, { enrollmentOpen: false });
    const inactive = seedClass(state, { status: "draft" });
    const { enroll } = await loadActions(state);

    expect(await enroll({ agent: agent(), classId: closed.id })).toMatchObject({ ok: false, message: "Enrollment is not open for this class" });
    expect(await enroll({ agent: agent(), classId: inactive.id })).toMatchObject({ ok: false, message: "Class is not active" });
    expect(state.emitted).toEqual([]);
  });

  it("reaches the statement instead of a pre-read: the seat count and enrollment are never read to refuse", async () => {
    // Mutation-check for M4: the pre-fix action called getClassEnrollmentCount / getClassEnrollment
    // to decide capacity and duplication; the fixed action classifies from the write's own flags.
    const state = freshState();
    const cls = seedClass(state, { maxStudents: 5 });
    const { enroll } = await loadActions(state);

    await enroll({ agent: agent(), classId: cls.id });

    expect(state.calls).not.toContain("getClassEnrollmentCount");
    expect(state.calls).not.toContain("getClassEnrollment");
  });
});

describe("drop — one gated update", () => {
  it("emits class.dropped on a real drop", async () => {
    const state = freshState();
    const cls = seedClass(state);
    const a = agent();
    enrol(state, cls.id, a.id);
    const { drop } = await loadActions(state);

    const result = await drop({ agent: a, classId: cls.id });

    expect(result.ok).toBe(true);
    expect(state.emitted).toHaveLength(1);
    expect(state.emitted[0]).toMatchObject({ kind: "class.dropped", actorAgentId: a.id, payload: { class_id: cls.id } });
  });

  it("refuses a drop of a non-enrolled agent and emits nothing", async () => {
    const state = freshState();
    const cls = seedClass(state);
    const { drop } = await loadActions(state);

    const result = await drop({ agent: agent(), classId: cls.id });

    expect(result).toMatchObject({ ok: false, code: "bad_request", message: "Not enrolled or already dropped" });
    expect(state.emitted).toEqual([]);
  });
});

describe("session message (student path) — session-active and enrollment gated in the write (M4)", () => {
  it("emits class.session_message on a committed student message, keyed on the session", async () => {
    const state = freshState();
    const cls = seedClass(state);
    const a = agent();
    enrol(state, cls.id, a.id);
    const sessionId = nextId("sess");
    state.sessions.set(sessionId, { id: sessionId, classId: cls.id, title: "S", type: "lecture", sequence: 1, status: "active", createdAt: "t" });
    const { sendSessionMessage } = await loadActions(state);

    const result = await sendSessionMessage({ agent: a, sessionId, content: "hi" });

    expect(result.ok).toBe(true);
    expect(state.emitted).toHaveLength(1);
    expect(state.emitted[0]).toMatchObject({
      kind: "class.session_message",
      actorAgentId: a.id,
      subjectType: "class_session",
      subjectId: sessionId,
      schoolId: "foundation",
      payload: { message_id: STORE_ASSIGNED_PAYLOAD_ID },
    });
  });

  it("refuses a message to a completed session and emits nothing", async () => {
    const state = freshState();
    const cls = seedClass(state);
    const a = agent();
    enrol(state, cls.id, a.id);
    const sessionId = nextId("sess");
    state.sessions.set(sessionId, { id: sessionId, classId: cls.id, title: "S", type: "lecture", sequence: 1, status: "completed", createdAt: "t" });
    const { sendSessionMessage } = await loadActions(state);

    const result = await sendSessionMessage({ agent: a, sessionId, content: "hi" });

    expect(result).toMatchObject({ ok: false, code: "bad_request", message: "Session is not active" });
    expect(state.emitted).toEqual([]);
  });

  it("refuses a non-enrolled sender and emits nothing", async () => {
    const state = freshState();
    const cls = seedClass(state);
    const sessionId = nextId("sess");
    state.sessions.set(sessionId, { id: sessionId, classId: cls.id, title: "S", type: "lecture", sequence: 1, status: "active", createdAt: "t" });
    const { sendSessionMessage } = await loadActions(state);

    const result = await sendSessionMessage({ agent: agent(), sessionId, content: "hi" });

    expect(result).toMatchObject({ ok: false, code: "forbidden", message: "Not enrolled in this class" });
    expect(state.emitted).toEqual([]);
  });
});

describe("evaluation submission — active-and-enrolled gated in the write (M4)", () => {
  function seedEval(state: FakeState, cls: StoredClass, overrides: Partial<StoredClassEvaluation> = {}): StoredClassEvaluation {
    const id = nextId("eval");
    const ev: StoredClassEvaluation = { id, classId: cls.id, title: "E", prompt: "P", status: "active", kind: "automatic", maxScore: 10, createdAt: "t", ...overrides };
    state.evals.set(id, ev);
    return ev;
  }

  it("emits class.evaluation_submitted on a committed submission", async () => {
    const state = freshState();
    const cls = seedClass(state);
    const a = agent();
    enrol(state, cls.id, a.id);
    const ev = seedEval(state, cls);
    const { submitEvaluation } = await loadActions(state);

    const result = await submitEvaluation({ agent: a, evaluationId: ev.id, response: "answer" });

    expect(result.ok).toBe(true);
    expect(state.emitted).toHaveLength(1);
    expect(state.emitted[0]).toMatchObject({
      kind: "class.evaluation_submitted",
      actorAgentId: a.id,
      subjectType: "class_evaluation_result",
      payload: { class_id: cls.id, evaluation_id: ev.id, result_id: STORE_ASSIGNED_PAYLOAD_ID },
    });
  });

  it("refuses an inactive evaluation and emits nothing", async () => {
    const state = freshState();
    const cls = seedClass(state);
    const a = agent();
    enrol(state, cls.id, a.id);
    const ev = seedEval(state, cls, { status: "draft" });
    const { submitEvaluation } = await loadActions(state);

    const result = await submitEvaluation({ agent: a, evaluationId: ev.id, response: "answer" });

    expect(result).toMatchObject({ ok: false, code: "bad_request", message: "Evaluation is not active" });
    expect(state.emitted).toEqual([]);
  });

  it("refuses a non-enrolled agent and emits nothing", async () => {
    const state = freshState();
    const cls = seedClass(state);
    const ev = seedEval(state, cls);
    const { submitEvaluation } = await loadActions(state);

    const result = await submitEvaluation({ agent: agent(), evaluationId: ev.id, response: "answer" });

    expect(result).toMatchObject({ ok: false, code: "forbidden", message: "Not enrolled in this class" });
    expect(state.emitted).toEqual([]);
  });
});

describe("the messages route splits the operator branch from the student branch (B3)", () => {
  async function loadRoute(state: FakeState, opers: { addOperatorClassSessionMessage: jest.Mock }) {
    jest.resetModules();
    jest.doMock("@/lib/store", () => makeStore(state));
    jest.doMock("@/lib/class-ops", () => ({
      addOperatorClassSessionMessage: opers.addOperatorClassSessionMessage,
      refreshClassFromSchoolYaml: jest.fn(),
    }));
    jest.doMock("@/lib/auth-professor", () => ({ getProfessorFromRequest: jest.fn(async () => professorRef.value) }));
    jest.doMock("@/lib/auth", () => ({
      requireAgent: jest.fn(async () => (agentRef.value ? { ok: true, agent: agentRef.value } : { ok: false, response: new Response(null, { status: 401 }) })),
      optionalAgent: jest.fn(async () => ({ agent: agentRef.value, denial: null })),
      jsonResponse: (body: unknown, status = 200) => Response.json(body, { status }),
      errorResponse: (error: string, hint?: string, status = 400) => Response.json({ success: false, error }, { status }),
    }));
    return import("@/app/api/v1/classes/[id]/sessions/[sessionId]/messages/route");
  }

  const professorRef: { value: { id: string } | null } = { value: null };
  const agentRef: { value: StoredAgent | null } = { value: null };

  function activeSession(state: FakeState, cls: StoredClass) {
    const sessionId = nextId("sess");
    state.sessions.set(sessionId, { id: sessionId, classId: cls.id, title: "S", type: "lecture", sequence: 1, status: "active", createdAt: "t" });
    return sessionId;
  }

  const req = () => new Request("https://safe.test", { method: "POST", body: JSON.stringify({ content: "hello" }) });

  it("routes a professor through the operator writer with no event", async () => {
    const state = freshState();
    const cls = seedClass(state, { professorId: "prof-1" });
    const sessionId = activeSession(state, cls);
    professorRef.value = { id: "prof-1" };
    agentRef.value = null;
    const oper = { addOperatorClassSessionMessage: jest.fn(async () => ({ id: "m", sequence: 1 })) };
    const { POST } = await loadRoute(state, oper);

    const res = await POST(req(), { params: Promise.resolve({ id: cls.id, sessionId }) });

    expect(res.status).toBe(201);
    expect(oper.addOperatorClassSessionMessage).toHaveBeenCalledWith(sessionId, "prof-1", "professor", "hello");
    expect(state.emitted).toEqual([]);
  });

  it("routes an agent teaching-assistant through the action, which emits class.session_message (B3: TA emits)", async () => {
    const state = freshState();
    const cls = seedClass(state, { professorId: "prof-1" });
    const sessionId = activeSession(state, cls);
    const ta = agent();
    state.assistants.add(key(cls.id, ta.id));
    professorRef.value = null;
    agentRef.value = ta;
    const oper = { addOperatorClassSessionMessage: jest.fn(async () => ({ id: "m", sequence: 1 })) };
    const { POST } = await loadRoute(state, oper);

    const res = await POST(req(), { params: Promise.resolve({ id: cls.id, sessionId }) });

    expect(res.status).toBe(201);
    // The TA no longer uses the history-silent operator writer; the action emits the event.
    expect(oper.addOperatorClassSessionMessage).not.toHaveBeenCalled();
    expect(state.emitted).toHaveLength(1);
    expect(state.emitted[0]).toMatchObject({ kind: "class.session_message", actorAgentId: ta.id, subjectId: sessionId });
  });

  it("routes an enrolled student through the action, which emits class.session_message", async () => {
    const state = freshState();
    const cls = seedClass(state, { professorId: "prof-1" });
    const sessionId = activeSession(state, cls);
    const student = agent();
    enrol(state, cls.id, student.id);
    professorRef.value = null;
    agentRef.value = student;
    const oper = { addOperatorClassSessionMessage: jest.fn(async () => ({ id: "m", sequence: 1 })) };
    const { POST } = await loadRoute(state, oper);

    const res = await POST(req(), { params: Promise.resolve({ id: cls.id, sessionId }) });

    expect(res.status).toBe(201);
    expect(oper.addOperatorClassSessionMessage).not.toHaveBeenCalled();
    expect(state.emitted).toHaveLength(1);
    expect(state.emitted[0]).toMatchObject({ kind: "class.session_message", actorAgentId: student.id, subjectId: sessionId });
  });
});
