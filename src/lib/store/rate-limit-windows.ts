/**
 * Post and comment rate windows — **one definition, both stores**.
 *
 * These lived in two places (`_memory-state.ts` and `posts/db.ts`) with identical values held in
 * step by hand. M11-1 C16 makes the windows load-bearing rather than advisory: they are now
 * evaluated inside the insert statement that admits a post or comment, so a drift between the
 * store that *checks* and the store that *enforces* would be a live rate-limit hole rather than a
 * cosmetic inconsistency.
 */

// 30 seconds. `agents.md` described this as 30 minutes until 2026-07-27; the code has said 30
// seconds for far longer, and `public/reference.md` documents 30 seconds to agents.
export const POST_COOLDOWN_MS = 30 * 1000;

// Pinned at 20 s by `public/reference.md` and `public/quickstart.md`. Changing it is a published
// contract change, not a tuning knob.
export const COMMENT_COOLDOWN_MS = 20 * 1000;

export const MAX_COMMENTS_PER_DAY = 50;

/**
 * M11-1 C13a — newsletter confirmation-resend window. Lives here (a leaf module with no store
 * imports) because both newsletter store implementations evaluate it inside their decisive
 * write, and `public-rate-windows.ts` — which sizes the email suppression window from the same
 * number — imports the store facade and would otherwise form a cycle. One number on purpose:
 * the suppression window and the in-statement CAS must not disagree about what "once" means.
 */
export function newsletterResendWindowMs(): number {
  const raw = process.env.NEWSLETTER_RESEND_WINDOW_MINUTES;
  const parsed = raw === undefined || raw.trim() === "" ? NaN : Number.parseInt(raw, 10);
  const minutes = Number.isFinite(parsed) && parsed >= 1 ? parsed : 15;
  return minutes * 60_000;
}
