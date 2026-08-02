import { randomBytes } from "crypto";
import { newsletterSubscribers } from "../_memory-state";
import { newsletterResendWindowMs } from "../rate-limit-windows";
import type { SubscribeNewsletterOutcome } from "./outcome";

function generateNewsletterToken(): string {
  return `nlt_${randomBytes(24).toString("base64url")}`;
}

/**
 * M11-1 C13a — same state branches as the db upsert, in one synchronous section (no `await`
 * between the read and the write, so interleaved promises cannot both observe "pending"):
 * confirmed-and-active is a no-op; pending/unsubscribed rotates and stamps only when the resend
 * window has elapsed; `unsubscribedAt` clears only on re-confirmation.
 */
export async function subscribeNewsletter(
  email: string,
  source?: string
): Promise<SubscribeNewsletterOutcome> {
  const normalized = email.trim().toLowerCase();
  const token = generateNewsletterToken();
  const now = Date.now();
  const existing = newsletterSubscribers.get(normalized);

  if (!existing) {
    newsletterSubscribers.set(normalized, {
      id: `sub_${now.toString(36)}_${randomBytes(6).toString("hex")}`,
      email: normalized,
      subscribedAt: new Date(now).toISOString(),
      source: source ?? null,
      confirmationToken: token,
      confirmedAt: null,
      unsubscribedAt: null,
      confirmationSentAt: new Date(now).toISOString(),
    });
    return { shouldSend: true, token };
  }

  const confirmedActive = existing.confirmedAt !== null && existing.unsubscribedAt === null;
  const sentAtMs = existing.confirmationSentAt ? Date.parse(existing.confirmationSentAt) : null;
  const resendElapsed = sentAtMs === null || sentAtMs < now - newsletterResendWindowMs();
  if (confirmedActive || !resendElapsed) {
    return { shouldSend: false, token: null };
  }

  newsletterSubscribers.set(normalized, {
    ...existing,
    subscribedAt: new Date(now).toISOString(),
    source: source ?? existing.source,
    confirmationToken: token,
    confirmedAt: null,
    // unsubscribedAt deliberately preserved — only re-confirmation clears it.
    confirmationSentAt: new Date(now).toISOString(),
  });
  return { shouldSend: true, token };
}

export async function confirmNewsletter(token: string): Promise<boolean> {
  for (const row of newsletterSubscribers.values()) {
    if (row.confirmationToken === token && row.confirmedAt === null) {
      row.confirmedAt = new Date().toISOString();
      row.unsubscribedAt = null;
      return true;
    }
  }
  return false;
}

export async function unsubscribeNewsletter(token: string): Promise<boolean> {
  for (const row of newsletterSubscribers.values()) {
    if (row.confirmationToken === token) {
      row.unsubscribedAt = new Date().toISOString();
      return true;
    }
  }
  return false;
}
