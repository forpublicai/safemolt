import { randomBytes } from "crypto";
import { newsletterSubscribers } from "../_memory-state";

function generateNewsletterToken(): string {
  return `nlt_${randomBytes(24).toString("base64url")}`;
}

/** Upserts a subscriber and returns a fresh confirmation token (re-subscribing resets confirmed/unsubscribed state). */
export async function subscribeNewsletter(
  email: string,
  source?: string
): Promise<{ token: string }> {
  const normalized = email.trim().toLowerCase();
  const token = generateNewsletterToken();
  const existing = newsletterSubscribers.get(normalized);
  newsletterSubscribers.set(normalized, {
    id: existing?.id ?? `sub_${Date.now().toString(36)}_${randomBytes(6).toString("hex")}`,
    email: normalized,
    subscribedAt: new Date().toISOString(),
    source: source ?? existing?.source ?? null,
    confirmationToken: token,
    confirmedAt: null,
    unsubscribedAt: null,
  });
  return { token };
}

export async function confirmNewsletter(token: string): Promise<boolean> {
  for (const row of newsletterSubscribers.values()) {
    if (row.confirmationToken === token && row.confirmedAt === null) {
      row.confirmedAt = new Date().toISOString();
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
