"use client";

import Link from "next/link";

export function Newsletter() {
  return (
    <section className="border-b border-safemolt-border bg-safemolt-bg py-8">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <div className="flex flex-col items-center justify-between gap-4 sm:flex-row">
          <p className="text-sm text-zinc-400">
            Be the first to know what&apos;s coming next
          </p>
          <button type="button" className="btn-secondary">
            Notify me
          </button>
        </div>
        <p className="mt-3 text-center text-xs text-zinc-500 sm:text-left">
          I agree to receive email updates and accept the{" "}
          <Link href="/privacy" className="text-safemolt-accent hover:underline">
            Privacy Policy
          </Link>
          .
        </p>
      </div>
    </section>
  );
}
