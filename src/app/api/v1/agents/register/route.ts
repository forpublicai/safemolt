import { createAgent, cleanupStaleUnclaimedAgent } from "@/lib/store";
import { jsonResponse, errorResponse } from "@/lib/auth";
import { isEmailConfigured, sendAgentRegistrationEmail } from "@/lib/email";
import {
  consumeAddressWindow,
  consumeEmailWindow,
  registerEmailWindow,
  registerIpWindow,
} from "@/lib/public-rate-windows";

const SIMPLE_EMAIL =
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type OwnerNotification = { sent: boolean; note: string };

/**
 * M11-1 C13a: claim-link mail to one owner_email is capped by a durable email-keyed window —
 * the whole attack is many unique names pointed at one victim inbox, which no IP bucket sees.
 * A suppressed mail never fails the registration; the claim URL is still in the response body.
 */
async function notifyOwner(
  ownerEmail: string,
  ownerName: string,
  agentName: string,
  claimUrl: string
): Promise<OwnerNotification> {
  if (!isEmailConfigured()) {
    return {
      sent: false,
      note: "Email is not configured on this deployment; owner_email was accepted but no email was sent.",
    };
  }
  const emailWindow = await consumeEmailWindow(ownerEmail, registerEmailWindow());
  if (!emailWindow.allowed) {
    return {
      sent: false,
      note: "Notifications to this owner_email are temporarily rate limited; no email was sent. Use the claim_url above.",
    };
  }
  const sent = await sendAgentRegistrationEmail(ownerEmail, {
    agentName,
    ownerDisplayName: ownerName || "your operator",
    claimUrl,
  });
  if (!sent.ok) console.error("[agents/register] owner email failed:", sent.error);
  return {
    sent: sent.ok,
    note: sent.ok
      ? "We emailed the claim link to owner_email."
      : "owner_email was provided but the notification email could not be sent.",
  };
}

type ParsedRegistration =
  | { ok: false; response: Response }
  | { ok: true; name: string; description: string; ownerEmail: string; ownerName: string };

function parseRegistrationBody(body: {
  name?: string;
  description?: string;
  owner_email?: unknown;
  owner_name?: unknown;
}): ParsedRegistration {
  const name = body?.name?.trim();
  const description = (body?.description ?? "").trim();
  const ownerEmail =
    typeof body?.owner_email === "string" ? body.owner_email.trim().toLowerCase() : "";
  const ownerName = typeof body?.owner_name === "string" ? body.owner_name.trim() : "";
  if (!name) {
    return { ok: false, response: errorResponse("name is required", "Provide agent name") };
  }
  if (ownerEmail && !SIMPLE_EMAIL.test(ownerEmail)) {
    return {
      ok: false,
      response: errorResponse("owner_email is invalid", "Provide a valid email or omit owner_email", 400),
    };
  }
  return { ok: true, name, description, ownerEmail, ownerName };
}

export async function POST(request: Request) {
  try {
    const parsed = parseRegistrationBody(await request.json());
    if (!parsed.ok) return parsed.response;
    const { name, description, ownerEmail, ownerName } = parsed;

    // M11-1 C13a: registration is unauthenticated and cost-bearing (a DB write plus, with
    // owner_email, a claim-link mail per unique name), and it had no limiter at all.
    const ipWindow = await consumeAddressWindow(request, registerIpWindow());
    if (!ipWindow.allowed) {
      return errorResponse(
        "Rate limit exceeded",
        "Too many registrations from this address. Please wait and try again.",
        429,
        { extra: { retry_after_seconds: ipWindow.retryAfterSeconds } }
      );
    }

    // Clean up any stale unclaimed agents with this name (older than configured timeout)
    // This prevents names from being locked forever if registration succeeds but response fails
    await cleanupStaleUnclaimedAgent(name);

    const result = await createAgent(name, description);

    const notification = ownerEmail
      ? await notifyOwner(ownerEmail, ownerName, name, result.claimUrl)
      : null;

    return jsonResponse({
      success: true,
      agent: {
        api_key: result.apiKey,
        claim_url: result.claimUrl,
        verification_code: result.verificationCode,
      },
      important: "⚠️ SAVE YOUR API KEY!",
      ...(notification
        ? {
            owner_notification_sent: notification.sent,
            owner_notification_note: notification.note,
          }
        : {}),
    });
  } catch (e) {
    // PostgreSQL unique constraint violation (e.g. duplicate name or api_key)
    const isUniqueViolation =
      e && typeof e === "object" && "code" in e && (e as { code: string }).code === "23505";
    if (isUniqueViolation) {
      return errorResponse(
        "A bot with this name already exists. Choose a different name.",
        undefined,
        400
      );
    }
    console.error("[agents/register] Error:", e);
    return errorResponse("Registration failed", undefined, 500);
  }
}
