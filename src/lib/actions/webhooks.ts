import { upsertAgentWebhook, getAgentWebhook, deleteAgentWebhook } from "@/lib/store";
import { generateSecret } from "@/lib/credentials";
import { validateWebhookUrl, resolvePublicAddresses } from "@/lib/webhooks/deliver";
import type { StoredAgent } from "@/lib/store-types";
import { actionError, actionOk, type ActionResult } from "./types";

/**
 * M11b Lane W (P5.1) — webhook registration actions. REST is the only surface (no tool executor):
 * external agents call this over the API, never from inside a loop tick.
 */

const SECRET_BYTES = 32;

function webhooksEnabled(): boolean {
  return process.env.WEBHOOKS_ENABLED === "true";
}

export type WebhookRegistrationMode = "primary" | "both";

export interface RegisterWebhookInput {
  url: string;
  mode: WebhookRegistrationMode;
}

export interface RegisteredWebhook {
  url: string;
  mode: string;
  secret: string;
}

/**
 * Two-step rollout gate (`webhooks_not_enabled`), then URL hygiene, then a fresh SSRF resolve — the
 * same check `deliverWakeup` repeats per attempt, run here once for early feedback at registration.
 * The secret is returned exactly once; `getWebhook` never carries it.
 */
export async function registerWebhook(
  agent: StoredAgent,
  input: RegisterWebhookInput
): Promise<ActionResult<RegisteredWebhook>> {
  if (!webhooksEnabled()) {
    return actionError("webhooks_not_enabled", "Webhook registration is not yet enabled");
  }
  if (input.mode !== "primary" && input.mode !== "both") {
    return actionError("bad_request", 'mode must be "primary" or "both"');
  }
  const validation = validateWebhookUrl(input.url);
  if (!validation.ok) {
    return actionError("bad_request", validation.reason);
  }
  try {
    await resolvePublicAddresses(new URL(input.url).hostname);
  } catch {
    return actionError("bad_request", "The hostname does not resolve to a public address");
  }
  const secret = generateSecret(SECRET_BYTES);
  const stored = await upsertAgentWebhook({ agentId: agent.id, url: input.url, secret, mode: input.mode });
  return actionOk({ url: stored.url, mode: stored.mode, secret: stored.secret });
}

export interface WebhookStatus {
  url: string;
  mode: string;
  disabled: boolean;
}

export async function getWebhook(agent: StoredAgent): Promise<ActionResult<WebhookStatus | null>> {
  const stored = await getAgentWebhook(agent.id);
  if (!stored) return actionOk(null);
  return actionOk({ url: stored.url, mode: stored.mode, disabled: stored.disabledAt !== null });
}

/** Idempotent delete: nothing to remove is success, matching the house's idempotent-delete convention. */
export async function removeWebhook(agent: StoredAgent): Promise<ActionResult<{ removed: boolean }>> {
  const result = await deleteAgentWebhook(agent.id);
  return actionOk({ removed: result.deleted });
}
