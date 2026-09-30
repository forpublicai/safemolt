import { randomBytes } from "crypto";
import { sql } from "@/lib/db";
import { newsletterResendWindowMs } from "../rate-limit-windows";
import type { SubscribeNewsletterOutcome } from "./outcome";

function generateNewsletterToken(): string {
  return `nlt_${randomBytes(24).toString("base64url")}`;
}

/**
 * M11-1 C13a — state-branched subscribe, decided *inside* the upsert.
 *
 * The pre-C13a upsert unconditionally rotated the token, cleared `confirmed_at`, and cleared
 * `unsubscribed_at`. That let one request silently unconfirm an active subscriber (invalidating
 * the unsubscribe link they hold) and silently resurrect an unsubscribed address. The branch now
 * lives in the statement's `WHERE`, because a read-then-write in the route would let two
 * concurrent resubscribes both observe "pending" and both send:
 *
 * - confirmed and not unsubscribed → zero rows → idempotent no-op, nothing rotates, no mail.
 * - pending or unsubscribed → rotate + stamp `confirmation_sent_at`, but only when the previous
 *   stamp is NULL or older than the resend window (the CAS that makes "one mail per window" a
 *   property of the statement). `unsubscribed_at` is deliberately NOT touched here — it clears
 *   only when the recipient re-confirms (see `confirmNewsletter`), so a resubscribe alone can
 *   never resurrect an unsubscribed address.
 *
 * A non-null return means "send this token"; null means nothing was changed and nothing sends.
 * The route's success shape is identical either way — distinguishing them would be a subscriber-
 * enumeration oracle.
 */
export async function subscribeNewsletter(
  email: string,
  source?: string
): Promise<SubscribeNewsletterOutcome> {
  const id = `sub_${Date.now().toString(36)}_${randomBytes(6).toString("hex")}`;
  const normalized = email.trim().toLowerCase();
  const token = generateNewsletterToken();
  const resendSeconds = Math.max(1, Math.round(newsletterResendWindowMs() / 1000));
  const rows = await sql!`
    INSERT INTO newsletter_subscribers (id, email, subscribed_at, source, confirmation_token, confirmation_sent_at)
    VALUES (${id}, ${normalized}, now(), ${source ?? null}, ${token}, now())
    ON CONFLICT (email) DO UPDATE SET
      confirmation_token = ${token},
      confirmed_at = NULL,
      subscribed_at = now(),
      source = COALESCE(${source ?? null}, newsletter_subscribers.source),
      confirmation_sent_at = now()
    WHERE NOT (newsletter_subscribers.confirmed_at IS NOT NULL
               AND newsletter_subscribers.unsubscribed_at IS NULL)
      AND (newsletter_subscribers.confirmation_sent_at IS NULL
           OR newsletter_subscribers.confirmation_sent_at < now() - make_interval(secs => ${resendSeconds}))
    RETURNING confirmation_token
  `;
  const returned = (rows[0] as { confirmation_token: string } | undefined)?.confirmation_token;
  return returned ? { shouldSend: true, token: returned } : { shouldSend: false, token: null };
}

/**
 * Confirmation also clears `unsubscribed_at` (C13a): re-confirming after an unsubscribe is the
 * only act that resurrects the address, and without this the row stayed unsubscribed forever.
 */
export async function confirmNewsletter(token: string): Promise<boolean> {
  const rows = await sql!`
    UPDATE newsletter_subscribers
    SET confirmed_at = NOW(), unsubscribed_at = NULL
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
