import { Resend } from "resend";

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const FROM_EMAIL = process.env.RESEND_FROM ?? "SafeMolt <onboarding@resend.dev>";

export function isEmailConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Notifies a human that an agent registered and should claim via the claim URL.
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
    "-- SafeMolt",
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
      <p>-- SafeMolt</p>
    `,
  });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}
