import { subscribeNewsletter, confirmNewsletter, unsubscribeNewsletter } from "@/lib/store";
import { newsletterSubscribers } from "@/lib/store/_memory-state";
import { newsletterResendWindowMs } from "@/lib/store/rate-limit-windows";

/** Backdate the resend stamp so the CAS admits the next rotate-and-send. */
function elapseResendWindow(email: string): void {
  const row = newsletterSubscribers.get(email);
  if (!row) throw new Error(`no subscriber row for ${email}`);
  row.confirmationSentAt = new Date(Date.now() - newsletterResendWindowMs() - 1000).toISOString();
}

describe("newsletter store (memory) — C13a state-branched lifecycle", () => {
  it("subscribes, confirms once, and unsubscribes by token", async () => {
    const outcome = await subscribeNewsletter("Agent@Example.COM", "homepage");
    expect(outcome.shouldSend).toBe(true);
    if (!outcome.shouldSend) throw new Error("unreachable");
    expect(outcome.token).toMatch(/^nlt_/);

    // Confirm succeeds once; a second confirm on the same token is a no-op.
    expect(await confirmNewsletter(outcome.token)).toBe(true);
    expect(await confirmNewsletter(outcome.token)).toBe(false);

    expect(await unsubscribeNewsletter(outcome.token)).toBe(true);
    expect(await unsubscribeNewsletter("nlt_unknown")).toBe(false);
  });

  it("pending resubscribe inside the resend window is a no-op; after it, the token rotates", async () => {
    const first = await subscribeNewsletter("repeat@example.com");
    if (!first.shouldSend) throw new Error("first subscribe must send");

    // Inside the window: no rotation, no send — the old confirmation link still works.
    const suppressed = await subscribeNewsletter("repeat@example.com");
    expect(suppressed.shouldSend).toBe(false);
    expect(suppressed.token).toBeNull();
    expect(newsletterSubscribers.get("repeat@example.com")?.confirmationToken).toBe(first.token);

    // After the window elapses the token rotates and the old one dies.
    elapseResendWindow("repeat@example.com");
    const second = await subscribeNewsletter("repeat@example.com");
    if (!second.shouldSend) throw new Error("post-window subscribe must send");
    expect(second.token).not.toBe(first.token);
    expect(await confirmNewsletter(first.token)).toBe(false);
    expect(await confirmNewsletter(second.token)).toBe(true);
  });

  it("a confirmed, active subscriber is untouched by resubscribes — no rotation, no unconfirm", async () => {
    const email = "active@example.com";
    const initial = await subscribeNewsletter(email);
    if (!initial.shouldSend) throw new Error("must send");
    await confirmNewsletter(initial.token);
    const before = { ...newsletterSubscribers.get(email)! };

    elapseResendWindow(email); // even with the resend window elapsed
    const attack = await subscribeNewsletter(email);
    expect(attack.shouldSend).toBe(false);

    const after = newsletterSubscribers.get(email)!;
    expect(after.confirmationToken).toBe(before.confirmationToken);
    expect(after.confirmedAt).toBe(before.confirmedAt);
    expect(after.unsubscribedAt).toBeNull();
  });

  it("resubscribing an unsubscribed address preserves unsubscribed_at until re-confirmation clears it", async () => {
    const email = "left@example.com";
    const initial = await subscribeNewsletter(email);
    if (!initial.shouldSend) throw new Error("must send");
    await confirmNewsletter(initial.token);
    await unsubscribeNewsletter(initial.token);

    elapseResendWindow(email);
    const resub = await subscribeNewsletter(email);
    expect(resub.shouldSend).toBe(true);
    if (!resub.shouldSend) throw new Error("unreachable");

    // Still unsubscribed — a resubscribe alone never resurrects the address.
    expect(newsletterSubscribers.get(email)?.unsubscribedAt).not.toBeNull();
    expect(newsletterSubscribers.get(email)?.confirmedAt).toBeNull();

    // Re-confirmation is the only act that clears it.
    expect(await confirmNewsletter(resub.token)).toBe(true);
    expect(newsletterSubscribers.get(email)?.unsubscribedAt).toBeNull();
    expect(newsletterSubscribers.get(email)?.confirmedAt).not.toBeNull();
  });

  it("concurrent resubscribes against one pending address rotate-and-send exactly once", async () => {
    const email = "raced@example.com";
    const first = await subscribeNewsletter(email);
    if (!first.shouldSend) throw new Error("must send");
    elapseResendWindow(email);

    const outcomes = await Promise.all([
      subscribeNewsletter(email),
      subscribeNewsletter(email),
      subscribeNewsletter(email),
    ]);
    expect(outcomes.filter((o) => o.shouldSend)).toHaveLength(1);
  });
});
