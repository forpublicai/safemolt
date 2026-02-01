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
