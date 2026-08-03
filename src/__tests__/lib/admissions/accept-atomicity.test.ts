/**
 * @jest-environment node
 *
 * M9 C11: offer acceptance must be one transaction. The accept-mark, accept
 * audit, status flip, agent admit, application flip, and finalize audit all
 * ride a single sql.transaction() batch — a failed audit statement aborts the
 * whole batch instead of leaving an admit-without-audit or
 * accept-without-finalize split.
 */

const state: {
  offerRow: Record<string, unknown> | null;
  batches: string[][];
  transactionError: Error | null;
  standaloneWrites: string[];
} = {
  offerRow: null,
  batches: [],
  transactionError: null,
  standaloneWrites: [],
};

jest.mock("@/lib/db", () => {
  const run = (strings: TemplateStringsArray | string) => {
    const text = typeof strings === "string" ? strings : strings.join("?");
    if (/^\s*(INSERT|UPDATE|DELETE)/.test(text)) state.standaloneWrites.push(text);
    if (text.includes("FROM admissions_offers WHERE id =")) {
      return Promise.resolve(state.offerRow ? [state.offerRow] : []);
    }
    if (text.includes("FROM user_agents")) {
      return Promise.resolve([{ "?column?": 1 }]);
    }
    return Promise.resolve([]);
  };

  const sql = Object.assign(
    (strings: TemplateStringsArray | string) => run(strings),
    {
      transaction: jest.fn(
        (build: (txn: (strings: TemplateStringsArray, ...params: unknown[]) => { __text: string }) => { __text: string }[]) => {
          const batch = build((strings) => ({ __text: strings.join("?") }));
          const texts = batch.map((q) => q.__text);
          state.batches.push(texts);
          if (state.transactionError) return Promise.reject(state.transactionError);
          // The double has to reflect what the batch DID, not just that it ran: since M11-1b D6 the
          // caller reads the offer back to decide between "ok" and "invalid", so a mock that leaves
          // the row untouched would report every acceptance as invalid.
          if (state.offerRow) {
            const stamp = new Date().toISOString();
            if (texts.some((t) => t.includes("SET accepted_at_agent = NOW()"))) {
              state.offerRow = { ...state.offerRow, accepted_at_agent: stamp };
            }
            if (texts.some((t) => t.includes("SET accepted_at_human = NOW()"))) {
              state.offerRow = { ...state.offerRow, accepted_at_human: stamp };
            }
          }
          return Promise.resolve(batch.map(() => []));
        }
      ),
    }
  );

  return { hasDatabase: () => true, sql };
});

jest.mock("@/lib/store", () => ({
  getAgentById: jest.fn(async () => null),
}));

import { acceptOfferAsAgentDb, acceptOfferAsHumanDb } from "@/lib/admissions/store-db";

function pendingOfferRow(): Record<string, unknown> {
  return {
    id: "offer-1",
    application_id: "app-1",
    agent_id: "agent-1",
    status: "pending",
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    created_at: new Date().toISOString(),
    accepted_at_agent: null,
    accepted_at_human: null,
    accepted_human_user_id: null,
  };
}

beforeEach(() => {
  state.offerRow = pendingOfferRow();
  state.batches.length = 0;
  state.transactionError = null;
  state.standaloneWrites.length = 0;
});

describe("acceptOfferAsAgentDb", () => {
  it("runs mark, audit, and finalize as one transaction batch with no standalone writes", async () => {
    const result = await acceptOfferAsAgentDb("offer-1", "agent-1");

    expect(result).toBe("ok");
    expect(state.batches).toHaveLength(1);
    const [batch] = state.batches;
    expect(batch.some((q) => q.includes("SET accepted_at_agent = NOW()"))).toBe(true);
    expect(batch.some((q) => q.includes("'accept_agent'"))).toBe(true);
    expect(batch.some((q) => q.includes("SET status = 'fully_accepted'"))).toBe(true);
    expect(batch.some((q) => q.includes("SET is_admitted = TRUE"))).toBe(true);
    expect(batch.some((q) => q.includes("SET state = 'admitted'"))).toBe(true);
    expect(batch.some((q) => q.includes("'admission_finalized'"))).toBe(true);
    // No BEGIN/COMMIT statements and no writes outside the batch.
    expect(state.standaloneWrites).toEqual([]);
  });

  it("propagates a failed batch (e.g. audit insert) so nothing half-applies", async () => {
    state.transactionError = new Error("audit insert failed");

    await expect(acceptOfferAsAgentDb("offer-1", "agent-1")).rejects.toThrow("audit insert failed");
    // Exactly one batch was attempted; no standalone fallback writes happened
    // before or after, so the failed acceptance left no partial state behind.
    expect(state.batches).toHaveLength(1);
    expect(state.standaloneWrites).toEqual([]);
  });

  it("rejects expired or foreign offers before writing anything", async () => {
    state.offerRow = { ...pendingOfferRow(), expires_at: new Date(Date.now() - 1000).toISOString() };
    await expect(acceptOfferAsAgentDb("offer-1", "agent-1")).resolves.toBe("invalid");

    state.offerRow = { ...pendingOfferRow(), agent_id: "someone-else" };
    await expect(acceptOfferAsAgentDb("offer-1", "agent-1")).resolves.toBe("invalid");

    expect(state.batches).toHaveLength(0);
  });
});

describe("acceptOfferAsHumanDb", () => {
  it("runs the human acceptance as one batch including finalize statements", async () => {
    const result = await acceptOfferAsHumanDb("offer-1", "user-1");

    expect(result).toBe("ok");
    expect(state.batches).toHaveLength(1);
    const [batch] = state.batches;
    expect(batch.some((q) => q.includes("SET accepted_at_human = NOW()"))).toBe(true);
    expect(batch.some((q) => q.includes("'accept_human'"))).toBe(true);
    expect(batch.some((q) => q.includes("'admission_finalized'"))).toBe(true);
    expect(state.standaloneWrites).toEqual([]);
  });
});
