import { consumeRateWindow, pruneExpiredRateWindows } from "@/lib/store";
import { rateWindows } from "@/lib/store/_memory-state";

/**
 * Memory-mode gates for the C13a window primitive. Keys are unique per test because the map is
 * process-global (that is the point of it); each test owns its namespace.
 */
describe("rate windows (memory)", () => {
  it("admits up to the limit inside one window and denies after", async () => {
    const key = `t1:${Date.now()}`;
    for (let i = 0; i < 3; i++) {
      expect((await consumeRateWindow(key, 60_000, 3)).allowed).toBe(true);
    }
    const denied = await consumeRateWindow(key, 60_000, 3);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(denied.retryAfterSeconds).toBeLessThanOrEqual(60);
  });

  it("interleaved concurrent consumes admit exactly limit callers", async () => {
    const key = `t2:${Date.now()}`;
    const outcomes = await Promise.all(
      Array.from({ length: 10 }, () => consumeRateWindow(key, 60_000, 4))
    );
    expect(outcomes.filter((o) => o.allowed)).toHaveLength(4);
  });

  it("a fresh window resets the allowance", async () => {
    const key = `t3:${Date.now()}`;
    expect((await consumeRateWindow(key, 60_000, 1)).allowed).toBe(true);
    expect((await consumeRateWindow(key, 60_000, 1)).allowed).toBe(false);
    // Simulate rollover by backdating the stored window.
    const entry = rateWindows.get(key)!;
    entry.windowStart -= 120_000;
    expect((await consumeRateWindow(key, 60_000, 1)).allowed).toBe(true);
  });

  it("prune removes only expired windows", async () => {
    const live = `t4-live:${Date.now()}`;
    const dead = `t4-dead:${Date.now()}`;
    await consumeRateWindow(live, 60_000, 5);
    await consumeRateWindow(dead, 60_000, 5);
    rateWindows.get(dead)!.windowStart = Date.now() - 3 * 3_600_000;

    await pruneExpiredRateWindows(3_600_000);
    expect(rateWindows.has(live)).toBe(true);
    expect(rateWindows.has(dead)).toBe(false);
  });
});
