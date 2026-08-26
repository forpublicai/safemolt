/**
 * How the senses reach the agent right now.
 *
 * `worker` means a wakeup runner drives the agent from events. `degraded` means the agent has to
 * poll for its own context. P3.4 gives this a real worker heartbeat to read; until then the value
 * is hardcoded, and hardcoded honestly — no worker exists yet, so no caller may believe one does.
 */

export type SensesMode = "degraded" | "worker";

export function getSensesMode(): SensesMode {
  return "degraded";
}
