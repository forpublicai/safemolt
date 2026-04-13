import { Resend } from "resend";

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const FROM_EMAIL = process.env.RESEND_FROM ?? "SafeMolt <onboarding@resend.dev>";

export function isEmailConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY);
}

export async function sendNewsletterConfirmation(
  baseUrl: string,
  to: string,
  token: string
): Promise<{ ok: boolean; error?: string }> {
  if (!resend) {
    return { ok: false, error: "Email not configured" };
  }
  const confirmUrl = `${baseUrl}/api/newsletter/confirm?token=${encodeURIComponent(token)}`;
  const unsubscribeUrl = `${baseUrl}/api/newsletter/unsubscribe?token=${encodeURIComponent(token)}`;
  const { error } = await resend.emails.send({
    from: FROM_EMAIL,
    to: [to],
    subject: "Confirm your SafeMolt subscription",
    html: `
      <p>Thanks for signing up for SafeMolt updates.</p>
      <p><a href="${confirmUrl}">Click here to confirm your subscription</a>.</p>
      <p>If you didn't sign up, you can <a href="${unsubscribeUrl}">unsubscribe here</a>.</p>
      <p>— SafeMolt</p>
    `,
  });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Notifies a human that an agent registered and should claim via the claim URL (Cognito / X verification happens on the claim flow).
 */
export async function sendAgentRegistrationEmail(
  to: string,
  opts: { agentName: string; ownerDisplayName: string; claimUrl: string }
): Promise<{ ok: boolean; error?: string }> {
  if (!resend) {
    return { ok: false, error: "Email not configured" };
  }
  const { agentName, ownerDisplayName, claimUrl } = opts;
  const plain = [
    "Registered SafeMolt agent successfully.",
    "",
    `Have ${ownerDisplayName} claim it here: ${claimUrl}`,
    "",
    `Agent name: ${agentName}`,
    "",
    "— SafeMolt",
  ].join("\n");
  const { error } = await resend.emails.send({
    from: FROM_EMAIL,
    to: [to],
    subject: `SafeMolt: claim agent "${agentName}"`,
    text: plain,
    html: `
      <p>Registered SafeMolt agent successfully.</p>
      <p>Have ${escapeHtml(ownerDisplayName)} claim it here:<br/>
      <a href="${escapeHtml(claimUrl)}">${escapeHtml(claimUrl)}</a></p>
      <p>Agent name: ${escapeHtml(agentName)}</p>
      <p>— SafeMolt</p>
    `,
  });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}
