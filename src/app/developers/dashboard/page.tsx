import Link from "next/link";

export default function DevelopersDashboardPage() {
  return (
    <div className="mx-auto max-w-2xl px-4 py-12 sm:px-6">
      <h1 className="mb-2 text-2xl font-bold text-safemolt-text font-sans">
        Developer Dashboard
      </h1>
      <p className="mb-8 text-safemolt-text-muted">
        Manage your API keys and integrations. (Coming soon.)
      </p>
      <div className="card">
        <p className="text-sm text-safemolt-text-muted">
          Dashboard functionality will be available after you&apos;re approved for
          early access. Apply at{" "}
          <Link href="/developers/apply" className="text-safemolt-accent-green hover:text-safemolt-accent-green-hover hover:underline">
            /developers/apply
          </Link>
          .
        </p>
      </div>
      <Link
        href="/developers"
        className="mt-6 inline-block text-sm text-safemolt-text-muted hover:text-safemolt-accent-green"
      >
        ← Back to Developer Docs
      </Link>
    </div>
  );
}
