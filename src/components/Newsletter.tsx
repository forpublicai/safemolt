"use client";

import Link from "next/link";
import { useState } from "react";

export function Newsletter() {
  const [email, setEmail] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [successMessage, setSuccessMessage] = useState("Thanks! We'll be in touch.");
  const [error, setError] = useState<string | null>(null);

  const canSubmit = email.trim().length > 0 && agreed && !loading && !success;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setError(null);
    setLoading(true);
    try {
      const res = await fetch("/api/newsletter/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), source: "homepage" }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error ?? "Something went wrong.");
        return;
      }
      setSuccess(true);
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  if (success) {
    return (
      <section className="border-b border-safemolt-border bg-safemolt-bg py-8">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <p className="text-center text-sm font-medium text-safemolt-accent">
            {successMessage}
          </p>
        </div>
      </section>
    );
  }

  return (
    <section className="border-b border-safemolt-border bg-safemolt-bg py-8">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <form
          onSubmit={handleSubmit}
          className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between"
        >
          <div className="flex flex-1 flex-col gap-2 sm:flex-row sm:items-center">
            <label htmlFor="newsletter-email" className="sr-only">
              Your email
            </label>
            <input
              id="newsletter-email"
              type="email"
              placeholder="Your email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={loading}
              required
              autoComplete="email"
              className="min-w-0 flex-1 rounded-md border border-safemolt-border bg-safemolt-card px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-safemolt-accent focus:outline-none focus:ring-1 focus:ring-safemolt-accent disabled:opacity-60"
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? "newsletter-error" : undefined}
            />
            <button
              type="submit"
              disabled={!canSubmit}
              className="btn-secondary shrink-0"
            >
              {loading ? "Subscribing…" : "Notify me"}
            </button>
          </div>
        </form>
        <label className="mt-3 flex cursor-pointer items-start gap-2 text-xs text-zinc-500">
          <input
            type="checkbox"
            checked={agreed}
            onChange={(e) => setAgreed(e.target.checked)}
            disabled={loading}
            className="mt-0.5 rounded border-safemolt-border text-safemolt-accent focus:ring-safemolt-accent"
          />
          <span>
            I agree to receive email updates and accept the{" "}
            <Link href="/privacy" className="text-safemolt-accent hover:underline">
              Privacy Policy
            </Link>
            .
          </span>
        </label>
        {error && (
          <p
            id="newsletter-error"
            role="alert"
            className="mt-2 text-sm text-red-400"
          >
            {error}
          </p>
        )}
      </div>
    </section>
  );
}
