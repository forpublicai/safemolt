/**
 * M11-2 u6 P3.1 — discipline test: deadline progression has exactly ONE unlocked door, and only the
 * locked entry point may use it.
 *
 * `checkDeadlines` (`src/lib/playground/session-manager.ts`) is no longer exported at all — the lock
 * lives inside the one progression entry point, `playground/lifecycle.ts`'s `runDeadlinesAndCap`, and
 * `session-manager.ts` exposes `runDeadlineProgressionUnlocked` solely for that file to call. If
 * anything else imports either name, deadline progression can run unlocked again — the exact defect
 * P3.1 closes (five call sites used to `await checkDeadlines()` directly, bypassing every guard).
 */
import { readFileSync, readdirSync } from "fs";
import { join, extname } from "path";

const SRC_ROOT = join(__dirname, "..", "..");

/** Every `.ts`/`.tsx` file under `src/`, excluding this test tree — a second importer belongs in
 * production code, not in a fixture. */
function listSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "__tests__" || entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      listSourceFiles(full, out);
    } else if (extname(entry.name) === ".ts" || extname(entry.name) === ".tsx") {
      out.push(full);
    }
  }
  return out;
}

const SESSION_MANAGER_PATH = join(SRC_ROOT, "lib", "playground", "session-manager.ts");
const LIFECYCLE_PATH = join(SRC_ROOT, "lib", "playground", "lifecycle.ts");

describe("checkDeadlines has no exported name", () => {
  it("session-manager.ts does not export checkDeadlines", () => {
    const source = readFileSync(SESSION_MANAGER_PATH, "utf8");
    expect(source).not.toMatch(/export\s+(async\s+)?function\s+checkDeadlines\b/);
    expect(source).not.toMatch(/export\s*\{\s*checkDeadlines\b/);
    // It must still exist, privately — this is a discipline test, not a deletion test.
    expect(source).toMatch(/^(?!export\s)async function checkDeadlines\(/m);
  });
});

describe("runDeadlineProgressionUnlocked is imported only from lifecycle.ts", () => {
  it("is exported from session-manager.ts", () => {
    const source = readFileSync(SESSION_MANAGER_PATH, "utf8");
    expect(source).toMatch(/export async function runDeadlineProgressionUnlocked\(/);
  });

  it("lifecycle.ts imports it", () => {
    const source = readFileSync(LIFECYCLE_PATH, "utf8");
    expect(source).toContain("runDeadlineProgressionUnlocked");
  });

  it("no OTHER production file imports it", () => {
    const offenders: string[] = [];
    for (const file of listSourceFiles(SRC_ROOT)) {
      if (file === LIFECYCLE_PATH || file === SESSION_MANAGER_PATH) continue;
      const source = readFileSync(file, "utf8");
      if (source.includes("runDeadlineProgressionUnlocked")) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});

describe("every former direct checkDeadlines() call site now routes through runDeadlinesAndCap", () => {
  // The tree carried FIVE (the plan says six; `ai/validation/m11-inventory.md` §6a records the
  // drift — the action and cancel POSTs never called it, per M11-1 C3): three playground GET routes,
  // agent-inbox.ts's inbox/context assembly, and the lifecycle wrapper itself. All five — plus the
  // two `runDeadlinesAndCap` callers that predate this lane (the cron route, the page render) — now
  // contend for ONE lock, which is the six-caller conversion this discipline test pins.
  const FORMER_DIRECT_CALLERS = [
    join(SRC_ROOT, "app", "api", "v1", "playground", "sessions", "route.ts"),
    join(SRC_ROOT, "app", "api", "v1", "playground", "sessions", "active", "route.ts"),
    join(SRC_ROOT, "app", "api", "v1", "playground", "sessions", "[id]", "route.ts"),
    join(SRC_ROOT, "lib", "agent-inbox.ts"),
  ];

  it.each(FORMER_DIRECT_CALLERS)("%s imports runDeadlinesAndCap, not checkDeadlines", (file) => {
    const source = readFileSync(file, "utf8");
    expect(source).toMatch(/from ['"]@\/lib\/playground\/lifecycle['"]/);
    expect(source).toContain("runDeadlinesAndCap");
    expect(source).not.toMatch(/import\s*\{[^}]*\bcheckDeadlines\b[^}]*\}\s*from\s*['"]@\/lib\/playground\/session-manager['"]/);
  });

  const PRE_EXISTING_CALLERS = [
    join(SRC_ROOT, "app", "playground", "page.tsx"),
    join(SRC_ROOT, "app", "api", "v1", "internal", "playground-deadlines", "route.ts"),
  ];

  it.each(PRE_EXISTING_CALLERS)("%s still calls runDeadlinesAndCap", (file) => {
    const source = readFileSync(file, "utf8");
    expect(source).toContain("runDeadlinesAndCap");
  });
});
