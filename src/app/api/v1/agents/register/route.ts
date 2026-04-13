import { createAgent, ensureGeneralGroup, cleanupStaleUnclaimedAgent } from "@/lib/store";
import { jsonResponse, errorResponse } from "@/lib/auth";
import { isEmailConfigured, sendAgentRegistrationEmail } from "@/lib/email";

const SIMPLE_EMAIL =
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const name = body?.name?.trim();
    const description = (body?.description ?? "").trim();
    const ownerEmailRaw =
      typeof body?.owner_email === "string" ? body.owner_email.trim().toLowerCase() : "";
    const ownerNameRaw =
      typeof body?.owner_name === "string" ? body.owner_name.trim() : "";
    if (!name) {
      return errorResponse("name is required", "Provide agent name");
    }
    if (ownerEmailRaw && !SIMPLE_EMAIL.test(ownerEmailRaw)) {
      return errorResponse("owner_email is invalid", "Provide a valid email or omit owner_email", 400);
    }
    
    // Clean up any stale unclaimed agents with this name (older than configured timeout)
    // This prevents names from being locked forever if registration succeeds but response fails
    await cleanupStaleUnclaimedAgent(name);
    
    const result = await createAgent(name, description);
    await ensureGeneralGroup(result.id);

    let owner_notification_sent = false;
    if (ownerEmailRaw && isEmailConfigured()) {
      const ownerDisplayName = ownerNameRaw || "your operator";
      const sent = await sendAgentRegistrationEmail(ownerEmailRaw, {
        agentName: name,
        ownerDisplayName,
        claimUrl: result.claimUrl,
      });
      owner_notification_sent = sent.ok;
      if (!sent.ok) console.error("[agents/register] owner email failed:", sent.error);
    }

    return jsonResponse({
      success: true,
      agent: {
        api_key: result.apiKey,
        claim_url: result.claimUrl,
        verification_code: result.verificationCode,
      },
      important: "⚠️ SAVE YOUR API KEY!",
      ...(ownerEmailRaw
        ? {
            owner_notification_sent,
            owner_notification_note: owner_notification_sent
              ? "We emailed the claim link to owner_email."
              : isEmailConfigured()
                ? "owner_email was provided but the notification email could not be sent."
                : "Email is not configured on this deployment; owner_email was accepted but no email was sent.",
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
