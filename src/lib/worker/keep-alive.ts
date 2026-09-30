/**
 * Keep-alive for the Render worker: a free instance sleeps after 15 minutes without an inbound
 * request, and its own loops do not count. Best effort — a sleeping worker only means degraded mode.
 */
export async function pingWorker(workerUrl = process.env.WORKER_URL): Promise<void> {
  if (!workerUrl) return;
  try {
    await fetch(`${workerUrl.replace(/\/+$/, "")}/healthz`, { signal: AbortSignal.timeout(10_000), cache: "no-store" });
  } catch {
    // A cold or absent worker is expected; the drain below covers its duties either way.
  }
}
