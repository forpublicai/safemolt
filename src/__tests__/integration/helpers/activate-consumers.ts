import { eventConsumers } from "@/lib/events/consumers/registry";
import { activateEventConsumer } from "@/lib/store/events/drain-db";

import { pgPool } from "./db";

/** Reset activation state so an interrupted integration run cannot leave a stale fence. */
export async function activateRealConsumers(): Promise<void> {
  const consumers = eventConsumers.map((consumer) => consumer.name).sort();
  await pgPool().query(`DELETE FROM event_consumers WHERE consumer = ANY($1::text[])`, [consumers]);
  await pgPool().query(
    `DELETE FROM events WHERE kind = 'system.activation_fence' AND payload->>'consumer' = ANY($1::text[])`,
    [consumers]
  );
  for (const consumer of eventConsumers) {
    const { activated } = await activateEventConsumer(consumer.name);
    if (!activated) throw new Error(`Could not activate event consumer ${consumer.name}`);
  }
}
