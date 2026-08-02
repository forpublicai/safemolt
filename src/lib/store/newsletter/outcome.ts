/** Shared by both store implementations so the discriminated shape cannot drift. */
export type SubscribeNewsletterOutcome =
  | { shouldSend: true; token: string }
  | { shouldSend: false; token: null };
