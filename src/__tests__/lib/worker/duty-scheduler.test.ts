/**
 * @jest-environment node
 */
import { createDutyScheduler, type DutyScheduler } from "@/lib/worker/duty-scheduler";

describe("worker duty scheduler idle backoff", () => {
  let scheduler: DutyScheduler | null = null;

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    scheduler?.stop();
    scheduler = null;
    jest.useRealTimers();
  });

  it("doubles an idle duty's delay up to its ceiling", async () => {
    const run = jest.fn(async () => false);
    scheduler = createDutyScheduler([{ name: "drain", intervalMs: 10_000, maxIntervalMs: 60_000, run }]);
    scheduler.start();

    await jest.advanceTimersByTimeAsync(10_000);
    expect(run).toHaveBeenCalledTimes(1);
    expect(scheduler.delays().drain).toBe(20_000);

    await jest.advanceTimersByTimeAsync(20_000 + 40_000);
    expect(run).toHaveBeenCalledTimes(3);
    expect(scheduler.delays().drain).toBe(60_000);

    await jest.advanceTimersByTimeAsync(60_000);
    expect(run).toHaveBeenCalledTimes(4);
    expect(scheduler.delays().drain).toBe(60_000);
  });

  it("keeps a fixed cadence without a ceiling, or when the duty reports nothing", async () => {
    const idle = jest.fn(async () => false);
    const silent = jest.fn(async () => undefined);
    scheduler = createDutyScheduler([
      { name: "idle-sweep", intervalMs: 60_000, run: idle },
      { name: "deadlines", intervalMs: 60_000, maxIntervalMs: 600_000, run: silent },
    ]);
    scheduler.start();

    await jest.advanceTimersByTimeAsync(180_000);
    expect(idle).toHaveBeenCalledTimes(3);
    expect(silent).toHaveBeenCalledTimes(3);
    expect(scheduler.delays()).toEqual({ "idle-sweep": 60_000, deadlines: 60_000 });
  });

  it("resets every duty to its base interval when any duty finds work, and wakes a backed-off one early", async () => {
    let drainFindsWork = false;
    const drain = jest.fn(async () => drainFindsWork);
    const wakeups = jest.fn(async () => false);
    scheduler = createDutyScheduler([
      { name: "drain", intervalMs: 10_000, maxIntervalMs: 20_000, run: drain },
      { name: "wakeups", intervalMs: 5_000, maxIntervalMs: 80_000, run: wakeups },
    ]);
    scheduler.start();

    // Wakeups backs off (5, 15, 35, 75 s) and would next run at 155 s; drain runs every 20 s.
    await jest.advanceTimersByTimeAsync(75_000);
    expect(scheduler.delays()).toEqual({ drain: 20_000, wakeups: 80_000 });
    expect(wakeups).toHaveBeenCalledTimes(4);

    drainFindsWork = true;
    await jest.advanceTimersByTimeAsync(15_000); // drain's pass at 90 s finds work
    expect(scheduler.delays()).toEqual({ drain: 10_000, wakeups: 5_000 });
    expect(wakeups).toHaveBeenCalledTimes(4);

    await jest.advanceTimersByTimeAsync(5_000); // 95 s, not 155 s
    expect(wakeups).toHaveBeenCalledTimes(5);
  });

  it("never overlaps a duty with its own next pass", async () => {
    let release: () => void = () => {};
    const run = jest.fn(
      () =>
        new Promise<boolean>((resolve) => {
          release = () => resolve(true);
        })
    );
    scheduler = createDutyScheduler([{ name: "wakeups", intervalMs: 5_000, maxIntervalMs: 60_000, run }]);
    scheduler.start();

    await jest.advanceTimersByTimeAsync(5_000);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(run).toHaveBeenCalledTimes(1);

    release();
    await jest.advanceTimersByTimeAsync(5_000);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("reports a failed pass, keeps its delay, and keeps scheduling", async () => {
    const onError = jest.fn();
    const run = jest.fn(async () => {
      throw new Error("neon down");
    });
    scheduler = createDutyScheduler([{ name: "webhooks", intervalMs: 5_000, maxIntervalMs: 60_000, run }], { onError });
    scheduler.start();

    await jest.advanceTimersByTimeAsync(15_000);
    expect(run).toHaveBeenCalledTimes(3);
    expect(onError).toHaveBeenCalledWith("webhooks", expect.any(Error));
    expect(scheduler.delays().webhooks).toBe(5_000);
  });

  it("arms nothing after stop, and hands every pass to track", async () => {
    const tracked: Promise<unknown>[] = [];
    const run = jest.fn(async () => false);
    scheduler = createDutyScheduler([{ name: "drain", intervalMs: 10_000, run }], {
      track: (promise) => tracked.push(promise),
    });
    scheduler.start();

    await jest.advanceTimersByTimeAsync(10_000);
    expect(tracked).toHaveLength(1);

    scheduler.stop();
    await jest.advanceTimersByTimeAsync(100_000);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
