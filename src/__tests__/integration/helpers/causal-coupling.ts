/**
 * M11-2 u1 — the no-ghost-events harness. **Every domain chunk reuses this check.**
 *
 * Decision 2's rule has two directions and only one of them is easy: co-committing an event with a
 * mutation is what a transaction gives you for free. The other direction is not. On the Neon HTTP
 * driver a `sql.transaction` batch is a fixed array of independent queries — a later element cannot
 * read an earlier element's `RETURNING` — so a free-standing event insert placed beside a mutation
 * is atomic at commit and still emits a **ghost event** whenever a concurrent racer turns the
 * mutation into a no-op. Events feed notifications and wakeups, so a ghost is a real reply
 * notification for a comment that was never written.
 *
 * The only way to see the difference is to run the composed statement with the decisive mutation
 * matching ZERO rows and assert nothing was written. That is what `expectNoGhostEvent` does, and it
 * is why the harness renders through the production `emitEventStatement` rather than through a
 * hand-written INSERT: a test that composed its own SQL would prove the test's SQL is coupled.
 */
import type { PreparedEvent } from "@/lib/events/kinds";
import { emitEventStatement } from "@/lib/store/events/statement";

import { neonSql } from "./db";

export interface CoupledMutation {
  /**
   * The decisive mutation, as a CTE body. It must RETURN rows only when the mutation actually
   * happened — that returning-ness is the entire gate.
   */
  decisiveSql: string;
  decisiveParams?: unknown[];
  event: PreparedEvent;
}

/** The CTE name the harness binds. Arbitrary, but fixed so failures read the same way every time. */
const CTE = "decisive";

/**
 * Run `WITH decisive AS (<mutation>) <gated event insert>` through the driver production uses, and
 * return the ids of the events it wrote.
 */
export async function runCoupledMutation(mutation: CoupledMutation): Promise<number[]> {
  const decisiveParams = mutation.decisiveParams ?? [];
  const emit = emitEventStatement(mutation.event, CTE, {
    firstParamIndex: decisiveParams.length + 1,
  });

  const rows = await neonSql()(
    `WITH ${CTE} AS (\n${mutation.decisiveSql}\n)\n${emit.text}`,
    [...decisiveParams, ...emit.params]
  );
  return (rows as Array<{ id: string | number }>).map((row) => Number(row.id));
}

/**
 * Assert that a mutation which matched nothing wrote no event — and that the log did not grow at
 * all, which catches an insert that landed somewhere the statement's `RETURNING` did not report.
 */
export async function expectNoGhostEvent(mutation: CoupledMutation): Promise<void> {
  const sql = neonSql();
  const before = await sql(`SELECT count(*)::int AS c FROM events`);
  const ids = await runCoupledMutation(mutation);
  const after = await sql(`SELECT count(*)::int AS c FROM events`);

  expect(ids).toEqual([]);
  expect((after[0] as { c: number }).c).toBe((before[0] as { c: number }).c);
}
