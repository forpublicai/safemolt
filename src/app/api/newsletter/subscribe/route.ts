import { NextRequest } from "next/server";
import { subscribeNewsletter } from "@/lib/store";
import { isEmailConfigured, sendNewsletterConfirmation } from "@/lib/email";
import {
  consumeAddressWindow,
  consumeEmailWindow,
  newsletterEmailWindow,
  newsletterIpWindow,
} from "@/lib/public-rate-windows";

// Forwarded headers are untrusted (see agents.md); never assemble URLs from them.
function getBaseUrl(request: NextRequest): string {
  if (process.env.NEXT_PUBLIC_APP_URL) return process.env.NEXT_PUBLIC_APP_URL.replace(/\/$/, "");
  return request.nextUrl.origin;
}

function isValidEmail(value: string): boolean {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed || trimmed.length > 254) return false;
  const at = trimmed.indexOf("@");
  if (at <= 0 || at === trimmed.length - 1) return false;
  const dot = trimmed.indexOf(".", at + 1);
  if (dot <= at + 1 || dot === trimmed.length - 1) return false;
  return true;
}

/**
 * The email suppression window is consumed BEFORE the store write, so "at most one confirmation
 * per address per window" holds across concurrent requests from different IP buckets. A denied
 * window short-circuits without touching the row — the lifecycle CAS would refuse the same write
 * anyway, and the caller sees the identical success shape either way.
 */
async function subscribeAndMaybeSend(
  request: NextRequest,
  normalizedEmail: string,
  source: string | undefined
): Promise<void> {
  const emailWindow = await consumeEmailWindow(normalizedEmail, newsletterEmailWindow());
  if (!emailWindow.allowed) return;

  const outcome = await subscribeNewsletter(normalizedEmail, source ?? "homepage");
  if (outcome.shouldSend && isEmailConfigured()) {
    const sent = await sendNewsletterConfirmation(getBaseUrl(request), normalizedEmail, outcome.token);
    if (!sent.ok) console.error("Newsletter confirmation email failed:", sent.error);
  }
}

/**
 * M11-1 C13a. Two durable windows and a state-branched store write:
 *
 * 1. IP window (trusted-address keyed, shared across instances) — the request limiter.
 * 2. Email window (one per resend window) — the mail-suppression limiter, consumed BEFORE the
 *    store write so "at most one confirmation per address per window" holds even across
 *    concurrent requests from different IP buckets. A denied email window short-circuits to the
 *    normal success shape: distinguishing it would be a subscriber-enumeration oracle, and the
 *    store write it skips is one the lifecycle CAS would refuse anyway.
 * 3. `subscribeNewsletter` decides confirmed-active (no-op) vs pending/unsubscribed
 *    (rotate + send) inside its upsert and returns whether to send.
 */
export async function POST(request: NextRequest) {
  let body: { email?: string; source?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { success: false, error: "Invalid JSON" },
      { status: 400 }
    );
  }

  const rawEmail = typeof body?.email === "string" ? body.email : "";
  if (!isValidEmail(rawEmail)) {
    return Response.json(
      { success: false, error: "Invalid email" },
      { status: 400 }
    );
  }

  const ipWindow = await consumeAddressWindow(request, newsletterIpWindow());
  if (!ipWindow.allowed) {
    return Response.json(
      {
        success: false,
        error: "Too many requests",
        retry_after_seconds: ipWindow.retryAfterSeconds,
      },
      { status: 429 }
    );
  }

  const source = typeof body?.source === "string" ? body.source.slice(0, 100) : undefined;
  const normalized = rawEmail.trim().toLowerCase();

  try {
    await subscribeAndMaybeSend(request, normalized, source);
    const message = isEmailConfigured()
      ? "You're on the list. Check your email to confirm."
      : "You're on the list.";
    return Response.json({ success: true, message });
  } catch (err) {
    console.error("Newsletter subscribe error:", err);
    return Response.json(
      { success: false, error: "Something went wrong. Please try again later." },
      { status: 500 }
    );
  }
}
