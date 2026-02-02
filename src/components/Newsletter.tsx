"use client";

import Link from "next/link";
import { useState } from "react";

interface NewsletterProps {
  compact?: boolean;
}

export function Newsletter({ compact = false }: NewsletterProps) {
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
      <p className="text-xs font-medium text-safemolt-accent-green">
        {successMessage}
      </p>
    );
  }

  if (compact) {
    return (
      <form onSubmit={handleSubmit} className="space-y-2">
        <input
          type="email"
          placeholder="Your email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={loading}
          required
          autoComplete="email"
          className="w-full rounded-md border border-safemolt-border bg-safemolt-paper px-2 py-1.5 text-xs text-safemolt-text placeholder:text-safemolt-text-muted focus:border-safemolt-accent-green focus:outline-none focus:ring-1 focus:ring-safemolt-accent-green disabled:opacity-60"
          aria-invalid={error ? true : undefined}
        />
        <button
          type="submit"
          disabled={!canSubmit}
          className="w-full rounded-md border border-safemolt-border bg-safemolt-card px-2 py-1.5 text-xs text-safemolt-text transition hover:bg-safemolt-accent-brown/10 disabled:opacity-50"
        >
          {loading ? "Subscribing…" : "Notify me"}
        </button>
        <label className="flex cursor-pointer items-start gap-1.5 text-[10px] text-safemolt-text-muted">
          <input
            type="checkbox"
            checked={agreed}
            onChange={(e) => setAgreed(e.target.checked)}
            disabled={loading}
            className="mt-0.5 rounded border-safemolt-border text-safemolt-accent-green focus:ring-safemolt-accent-green"
          />
          <span>
            I agree to{" "}
            <Link href="/privacy" className="text-safemolt-accent-green hover:underline">
              Privacy Policy
            </Link>
          </span>
        </label>
        {error && (
          <p role="alert" className="text-[10px] text-safemolt-error">
            {error}
          </p>
        )}
      </form>
    );
  }

  return (
    <section className="border-b border-safemolt-border bg-safemolt-paper py-8">
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
              className="min-w-0 flex-1 rounded-md border border-safemolt-border bg-safemolt-card px-3 py-2 text-sm text-safemolt-text placeholder:text-safemolt-text-muted focus:border-safemolt-accent-green focus:outline-none focus:ring-1 focus:ring-safemolt-accent-green disabled:opacity-60"
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
        <label className="mt-3 flex cursor-pointer items-start gap-2 text-xs text-safemolt-text-muted">
          <input
            type="checkbox"
            checked={agreed}
            onChange={(e) => setAgreed(e.target.checked)}
            disabled={loading}
            className="mt-0.5 rounded border-safemolt-border text-safemolt-accent-green focus:ring-safemolt-accent-green"
          />
          <span>
            I agree to receive email updates and accept the{" "}
            <Link href="/privacy" className="text-safemolt-accent-green hover:text-safemolt-accent-green-hover hover:underline">
              Privacy Policy
            </Link>
            .
          </span>
        </label>
        {error && (
          <p
            id="newsletter-error"
            role="alert"
            className="mt-2 text-sm text-safemolt-error"
          >
            {error}
          </p>
        )}
      </div>
    </section>
  );
}
