/**
 * M11-2 u3f-core (P1.4) CLASSES — the wire-shape characterization (M9).
 *
 * The B3 / M4 / M8 changes re-plumbed how the class routes reach the store; this pins that they did
 * NOT move the bytes on the wire. Each legacy shape is taken from the pre-implementation tree
 * (`a2585c5`): the enroll/drop/submit statuses and bodies, and the school denial the migration had
 * flattened to a bare `forbidden` — restored here to the `vetting_required` envelope its clients
 * receive.
 *
 * The routes run for real over a fake store; only `requireAgent` is stubbed. `@/lib/school-context`
 * is the REAL module so the denial reason and its envelope are exercised end to end.
 *
 * @jest-environment node
 */
import type { StoredAgent, StoredClass, StoredClassEnrollment, StoredClassEvaluation, StoredClassSession } from "@/lib/store-types";

let seq = 0;
const nextId = (l: string) => `u3fwire${l}${(seq += 1)}`;

interface Fake {
  classes: Map<string, StoredClass>;
  enrollments: Map<string, StoredClassEnrollment>;
  sessions: Map<string, StoredClassSession>;
  evals: Map<string, StoredClassEvaluation>;
}
const k = (c: string, a: string) => `${c}:${a}`;

let state: Fake;
let currentAgent: StoredAgent;

function makeStore(s: Fake) {
  const count = (c: string) => [...s.enrollments.values()].filter((e) => e.classId === c && e.status !== "dropped").length;
  return {
    getClassById: jest.fn(async (id: string) => s.classes.get(id) ?? null),
    getClassSession: jest.fn(async (id: string) => s.sessions.get(id) ?? null),
    getClassEvaluation: jest.fn(async (id: string) => s.evals.get(id) ?? null),
    getClassEnrollment: jest.fn(async (c: string, a: string) => s.enrollments.get(k(c, a)) ?? null),
    getClassSessionMessages: jest.fn(async () => []),
    isClassAssistant: jest.fn(async () => false),
    enrollInClass: jest.fn(async (c: string, a: string) => {
      const cls = s.classes.get(c);
      if (!cls) return { enrollment: null, classPresent: false, isOpen: false, isActive: false, already: false, atCapacity: false };
      const existing = s.enrollments.get(k(c, a));
      const already = !!existing && existing.status !== "dropped";
      const atCapacity = cls.maxStudents != null && count(c) >= cls.maxStudents;
      const isOpen = !!cls.enrollmentOpen;
      const isActive = cls.status === "active";
      const pass = isOpen && isActive && !already && !atCapacity;
      const row: StoredClassEnrollment = { id: "enrl_1", classId: c, agentId: a, status: "enrolled", enrolledAt: "2026-01-01T00:00:00.000Z" };
      return { enrollment: pass ? row : null, classPresent: true, isOpen, isActive, already, atCapacity };
    }),
    dropClass: jest.fn(async (c: string, a: string) => {
      const existing = s.enrollments.get(k(c, a));
      return !!existing && existing.status !== "dropped";
    }),
    saveClassEvaluationResult: jest.fn(async (evaluationId: string, agentId: string, response?: string, _s?: number, maxScore?: number) => ({
      id: "cres_1", evaluationId, agentId, response, score: undefined, maxScore, resultData: undefined, feedback: undefined, completedAt: "2026-01-01T00:00:00.000Z",
    })),
  };
}

function baseState(): Fake {
  return { classes: new Map(), enrollments: new Map(), sessions: new Map(), evals: new Map() };
}

function seedClass(overrides: Partial<StoredClass> = {}): StoredClass {
  const id = overrides.id ?? nextId("cls");
  const cls: StoredClass = { id, slug: id, schoolId: "foundation", professorId: "prof", name: "Class", status: "active", enrollmentOpen: true, createdAt: "2026-01-01T00:00:00.000Z", ...overrides };
  state.classes.set(cls.id, cls);
  return cls;
}

beforeEach(() => {
  jest.resetModules();
  state = baseState();
  currentAgent = { id: "agent-1", name: "agent-1", apiKey: "k", isVetted: true, isAdmitted: true } as StoredAgent;
  jest.doMock("@/lib/store", () => makeStore(state));
  jest.doMock("@/lib/auth", () => {
    const actual = jest.requireActual("@/lib/auth");
    return { ...actual, requireAgent: jest.fn(async () => ({ ok: true, agent: currentAgent })) };
  });
});

const post = (body: Record<string, unknown> = {}) => new Request("https://safe.test", { method: "POST", body: JSON.stringify(body) });

describe("enroll route wire shape", () => {
  async function enroll(id: string) {
    const { POST } = await import("@/app/api/v1/classes/[id]/enroll/route");
    return POST(post(), { params: Promise.resolve({ id }) });
  }

  it("returns 201 { success, data: enrollment } on success", async () => {
    const cls = seedClass();
    const res = await enroll(cls.id);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ success: true, data: { id: "enrl_1", classId: cls.id, agentId: "agent-1", status: "enrolled", enrolledAt: "2026-01-01T00:00:00.000Z" } });
  });

  it("keeps every domain refusal at 400 with its legacy message", async () => {
    const cases: Array<[Partial<StoredClass>, string, () => void]> = [
      [{ enrollmentOpen: false }, "Enrollment is not open for this class", () => {}],
      [{ status: "draft" }, "Class is not active", () => {}],
    ];
    for (const [overrides, message] of cases) {
      const cls = seedClass(overrides);
      const res = await enroll(cls.id);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe(message);
    }
    // Already enrolled and full both 400.
    const dup = seedClass();
    state.enrollments.set(k(dup.id, "agent-1"), { id: "e", classId: dup.id, agentId: "agent-1", status: "enrolled", enrolledAt: "t" });
    expect((await enroll(dup.id)).status).toBe(400);

    const full = seedClass({ maxStudents: 1 });
    state.enrollments.set(k(full.id, "other"), { id: "e2", classId: full.id, agentId: "other", status: "enrolled", enrolledAt: "t" });
    const fullRes = await enroll(full.id);
    expect(fullRes.status).toBe(400);
    expect((await fullRes.json()).error).toBe("Class is full");
  });

  it("returns 404 for a missing class", async () => {
    const res = await enroll(nextId("missing"));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("Class not found");
  });

  it("renders the vetting_required envelope for an unvetted agent (M9 restored)", async () => {
    const cls = seedClass();
    currentAgent = { id: "agent-1", name: "agent-1", apiKey: "k", isVetted: false, isAdmitted: false } as StoredAgent;
    const res = await enroll(cls.id);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toMatchObject({ success: false, vetting_required: true, error_detail: { code: "forbidden" } });
    expect(body.error).toContain("vetted");
  });
});

describe("drop route wire shape", () => {
  async function drop(id: string) {
    const { POST } = await import("@/app/api/v1/classes/[id]/drop/route");
    return POST(post(), { params: Promise.resolve({ id }) });
  }

  it("returns { success, message } on a real drop", async () => {
    const cls = seedClass();
    state.enrollments.set(k(cls.id, "agent-1"), { id: "e", classId: cls.id, agentId: "agent-1", status: "enrolled", enrolledAt: "t" });
    const res = await drop(cls.id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, message: "Dropped from class" });
  });

  it("returns 400 'Not enrolled or already dropped' otherwise", async () => {
    const cls = seedClass();
    const res = await drop(cls.id);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Not enrolled or already dropped");
  });
});

describe("evaluation submit route wire shape", () => {
  async function submit(id: string, evalId: string, body: Record<string, unknown> = { response: "answer" }) {
    const { POST } = await import("@/app/api/v1/classes/[id]/evaluations/[evalId]/submit/route");
    return POST(post(body), { params: Promise.resolve({ id, evalId }) });
  }
  function seedEval(cls: StoredClass, overrides: Partial<StoredClassEvaluation> = {}): StoredClassEvaluation {
    const id = nextId("eval");
    const ev: StoredClassEvaluation = { id, classId: cls.id, title: "E", prompt: "P", status: "active", kind: "self_serve", maxScore: 10, createdAt: "2026-01-01T00:00:00.000Z", ...overrides };
    state.evals.set(id, ev);
    return ev;
  }

  it("returns 201 with data + meta on a synchronous submission", async () => {
    const cls = seedClass();
    state.enrollments.set(k(cls.id, "agent-1"), { id: "e", classId: cls.id, agentId: "agent-1", status: "enrolled", enrolledAt: "t" });
    const ev = seedEval(cls);
    const res = await submit(cls.id, ev.id);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data).toMatchObject({ id: "cres_1", evaluation_id: ev.id, agent_id: "agent-1", grading_mode: "sync", result_state: "completed", kind: "self_serve", prompt: "P" });
    expect(body.meta).toMatchObject({ class_id: cls.id, evaluation_id: ev.id, synchronous: true });
  });

  it("returns 403 not-enrolled before 404 eval-missing (legacy order)", async () => {
    const cls = seedClass();
    const res = await submit(cls.id, nextId("noeval"));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("Not enrolled in this class");
  });

  it("returns 404 for an evaluation on the wrong class", async () => {
    const cls = seedClass();
    state.enrollments.set(k(cls.id, "agent-1"), { id: "e", classId: cls.id, agentId: "agent-1", status: "enrolled", enrolledAt: "t" });
    const other = seedClass();
    const ev = seedEval(other); // belongs to another class
    const res = await submit(cls.id, ev.id);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("Evaluation not found");
  });

  it("returns 400 for an inactive evaluation", async () => {
    const cls = seedClass();
    state.enrollments.set(k(cls.id, "agent-1"), { id: "e", classId: cls.id, agentId: "agent-1", status: "enrolled", enrolledAt: "t" });
    const ev = seedEval(cls, { status: "draft" });
    const res = await submit(cls.id, ev.id);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Evaluation is not active");
  });
});
