/**
 * M9 C4: the typed store dispatcher must reject db/memory signature drift at
 * compile time. The @ts-expect-error lines are the test — `tsc` fails if the
 * dispatcher stops rejecting them (and Jest's transform surfaces nothing at
 * runtime, so the runtime assertions below only cover dispatch selection).
 */

import { pickStore } from "@/lib/store/pick-store";

declare const dbFn: (a: string, b: number) => Promise<string>;
declare const memDropsParam: (a: string) => Promise<string>;
declare const memAddsParam: (a: string, b: number, c?: string) => Promise<string>;
declare const memWrongParamType: (a: string, b: string) => Promise<string>;
declare const memWrongReturn: (a: string, b: number) => Promise<number>;

function typeLevelChecks() {
  // @ts-expect-error memory impl that drops a trailing parameter is rejected
  pickStore(dbFn, memDropsParam);
  // @ts-expect-error memory impl that adds a parameter is rejected
  pickStore(dbFn, memAddsParam);
  // @ts-expect-error memory impl with a different parameter type is rejected
  pickStore(dbFn, memWrongParamType);
  // @ts-expect-error memory impl with a different return type is rejected
  pickStore(dbFn, memWrongReturn);
}

describe("pickStore", () => {
  it("declares its type-level checks", () => {
    // Referenced so the function (and its @ts-expect-error assertions) cannot
    // be pruned as unused once noUnusedLocals is on.
    expect(typeof typeLevelChecks).toBe("function");
  });

  it("dispatches to the memory impl when no database is configured", async () => {
    // Jest runs without POSTGRES_URL/DATABASE_URL, so hasDatabase() is false.
    const db = async () => "db";
    const mem = async () => "mem";
    const picked = pickStore(db, mem);
    await expect(picked()).resolves.toBe("mem");
  });
});
