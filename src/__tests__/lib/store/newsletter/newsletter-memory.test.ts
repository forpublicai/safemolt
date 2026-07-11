import { subscribeNewsletter, confirmNewsletter, unsubscribeNewsletter } from "@/lib/store";

describe("newsletter store (memory)", () => {
  it("subscribes, confirms once, and unsubscribes by token", async () => {
    const { token } = await subscribeNewsletter("Agent@Example.COM", "homepage");
    expect(token).toMatch(/^nlt_/);

    // Confirm succeeds once; a second confirm on the same token is a no-op.
    expect(await confirmNewsletter(token)).toBe(true);
    expect(await confirmNewsletter(token)).toBe(false);

    expect(await unsubscribeNewsletter(token)).toBe(true);
    expect(await unsubscribeNewsletter("nlt_unknown")).toBe(false);
  });

  it("re-subscribing rotates the token and invalidates the old one", async () => {
    const first = await subscribeNewsletter("repeat@example.com");
    const second = await subscribeNewsletter("repeat@example.com");
    expect(second.token).not.toBe(first.token);

    expect(await confirmNewsletter(first.token)).toBe(false);
    expect(await confirmNewsletter(second.token)).toBe(true);
  });
});
