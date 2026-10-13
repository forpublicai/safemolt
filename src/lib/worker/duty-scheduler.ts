/**
 * The worker's duty timers, with an idle backoff.
 *
 * Every duty pass is at least one HTTPS request to Neon, and Render bills the worker's outbound
 * traffic. With fixed 5-10 s cadences an idle worker sent ~19 MB an hour (2026-10-13: ~16 GB a month
 * against the Hobby plan's 5 GB), all of it asking an empty queue the same question. So a pass that
 * finds nothing doubles its own delay, up to `maxIntervalMs`, and any pass that finds work resets
 * EVERY duty to its base interval: drained events are what create wakeups and webhook deliveries,
 * and an idle sweep's enqueue is what the wakeup duty claims, so one duty's work is the others' cue.
 *
 * A timeout chain, not `setInterval`: the next pass is armed only after the previous one settles,
 * which is what the old per-duty `busy` flag approximated, and it is what lets the delay change.
 */

export interface DutySpec {
  name: string;
  /** The cadence while there is work. */
  intervalMs: number;
  /** Idle ceiling; absent (or not above `intervalMs`) keeps a fixed cadence. */
  maxIntervalMs?: number;
  /** `true` = found work, `false` = idle. `void` (or a throw) leaves the delay unchanged. */
  run: () => Promise<boolean | void>;
}

export interface DutySchedulerOptions {
  /** Registers each pass's promise, so shutdown can wait for in-flight work. */
  track?: (promise: Promise<unknown>) => void;
  onError?: (name: string, error: unknown) => void;
}

export interface DutyScheduler {
  start(): void;
  /** Arms nothing new; a pass already running finishes. */
  stop(): void;
  /** The delay each duty will wait after its current pass — for tests and logs. */
  delays(): Record<string, number>;
}

interface DutyState {
  spec: DutySpec;
  maxMs: number;
  delayMs: number;
  timer: ReturnType<typeof setTimeout> | null;
  dueAt: number;
  busy: boolean;
}

export function createDutyScheduler(specs: DutySpec[], options: DutySchedulerOptions = {}): DutyScheduler {
  let stopped = false;
  const duties: DutyState[] = specs.map((spec) => ({
    spec,
    maxMs: Math.max(spec.intervalMs, spec.maxIntervalMs ?? spec.intervalMs),
    delayMs: spec.intervalMs,
    timer: null,
    dueAt: 0,
    busy: false,
  }));

  function arm(duty: DutyState, delayMs: number): void {
    if (stopped) return;
    if (duty.timer) clearTimeout(duty.timer);
    duty.dueAt = Date.now() + delayMs;
    duty.timer = setTimeout(() => runPass(duty), delayMs);
  }

  /** Every duty back to its base interval; a waiting one is re-armed only if that brings it sooner. */
  function noteActivity(): void {
    for (const duty of duties) {
      duty.delayMs = duty.spec.intervalMs;
      if (duty.busy || !duty.timer) continue;
      if (duty.dueAt > Date.now() + duty.delayMs) arm(duty, duty.delayMs);
    }
  }

  function settle(duty: DutyState, foundWork: boolean | void): void {
    if (foundWork === true) noteActivity();
    else if (foundWork === false) duty.delayMs = Math.min(duty.delayMs * 2, duty.maxMs);
  }

  function runPass(duty: DutyState): void {
    duty.timer = null;
    if (stopped) return;
    duty.busy = true;
    const pass = duty.spec
      .run()
      .then(
        (foundWork) => settle(duty, foundWork),
        (error) => options.onError?.(duty.spec.name, error)
      )
      .finally(() => {
        duty.busy = false;
        arm(duty, duty.delayMs);
      });
    options.track?.(pass);
  }

  return {
    start() {
      for (const duty of duties) arm(duty, duty.delayMs);
    },
    stop() {
      stopped = true;
      for (const duty of duties) {
        if (duty.timer) clearTimeout(duty.timer);
        duty.timer = null;
      }
    },
    delays() {
      return Object.fromEntries(duties.map((duty) => [duty.spec.name, duty.delayMs]));
    },
  };
}
