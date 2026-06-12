import { hasDatabase } from "@/lib/db";

/**
 * Compile-time arity parity. `Mem extends Db` alone lets a memory
 * implementation silently ignore trailing parameters (it would still be
 * assignable); requiring equal parameter-list lengths closes that hole.
 */
type SameArity<DbFn, MemFn> = DbFn extends (...a: infer DbArgs) => unknown
  ? MemFn extends (...b: infer MemArgs) => unknown
    ? DbArgs["length"] extends MemArgs["length"]
      ? MemArgs["length"] extends DbArgs["length"]
        ? unknown
        : ["memory impl parameter count differs from db impl", DbArgs["length"], MemArgs["length"]]
      : ["memory impl parameter count differs from db impl", DbArgs["length"], MemArgs["length"]]
    : unknown
  : unknown;

/**
 * Typed db/memory dispatcher for dual-implementation store domains.
 *
 * Jest runs the memory side while production runs the db side, so any
 * signature divergence between the two is a bug that tests cannot see
 * (M9/B1: saveEvaluationResult drifted to different parameter lists and
 * different points math on each side). Routing every store/<domain>/index.ts
 * re-export through pickStore makes that divergence a compile error at the
 * dispatch site:
 *
 *   export const saveEvaluationResult =
 *     pickStore(db.saveEvaluationResult, mem.saveEvaluationResult);
 *
 * `Mem extends Db` forces the memory implementation to be call-compatible
 * with the db implementation; SameArity additionally rejects a memory
 * implementation that drops trailing parameters. Dual-impl domains must
 * register every export through this helper (DB-only domains — classes,
 * ao — keep their plain `export ... from "./db"` form).
 *
 * The guarantee is signature-level only: two impls with identical types can
 * still behave differently (e.g. memory joinGroup skips evaluation-requirement
 * checks by design). Behavioral parity is owned by shared pure helpers both
 * sides call (computeEvaluationResultFields) and characterization tests.
 */
export function pickStore<Db, Mem extends Db>(
  dbImpl: Db,
  memImpl: Mem & SameArity<Db, Mem>
): Db {
  return hasDatabase() ? dbImpl : memImpl;
}
