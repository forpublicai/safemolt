"use client";

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
      </div>
    </section>
  );
}
