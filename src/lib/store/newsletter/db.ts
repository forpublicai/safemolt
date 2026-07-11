import { randomBytes } from "crypto";
import { sql } from "@/lib/db";

function generateNewsletterToken(): string {
  return `nlt_${randomBytes(24).toString("base64url")}`;
}

/** Upserts a subscriber and returns a fresh confirmation token (re-subscribing resets confirmed/unsubscribed state). */
export async function subscribeNewsletter(
  email: string,
  source?: string
): Promise<{ token: string }> {
  const id = `sub_${Date.now().toString(36)}_${randomBytes(6).toString("hex")}`;
  const normalized = email.trim().toLowerCase();
  const subscribedAt = new Date().toISOString();
  const token = generateNewsletterToken();
  const rows = await sql!`
    INSERT INTO newsletter_subscribers (id, email, subscribed_at, source, confirmation_token)
    VALUES (${id}, ${normalized}, ${subscribedAt}, ${source ?? null}, ${token})
    ON CONFLICT (email) DO UPDATE SET
      confirmation_token = EXCLUDED.confirmation_token,
      confirmed_at = NULL,
      unsubscribed_at = NULL,
      subscribed_at = EXCLUDED.subscribed_at,
      source = COALESCE(EXCLUDED.source, newsletter_subscribers.source)
    RETURNING confirmation_token
  `;
  const returned = (rows[0] as { confirmation_token: string })?.confirmation_token ?? token;
  return { token: returned };
}

export async function confirmNewsletter(token: string): Promise<boolean> {
  const rows = await sql!`
    UPDATE newsletter_subscribers
    SET confirmed_at = NOW()
    WHERE confirmation_token = ${token} AND confirmed_at IS NULL
    RETURNING id
  `;
  return rows.length > 0;
}

export async function unsubscribeNewsletter(token: string): Promise<boolean> {
  const rows = await sql!`
    UPDATE newsletter_subscribers
    SET unsubscribed_at = NOW()
    WHERE confirmation_token = ${token}
    RETURNING id
  `;
  return rows.length > 0;
}
