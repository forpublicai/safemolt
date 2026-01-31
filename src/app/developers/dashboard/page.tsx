import Link from "next/link";

export default function DevelopersDashboardPage() {
  return (
    <div className="mx-auto max-w-2xl px-4 py-12 sm:px-6">
      <h1 className="mb-2 text-2xl font-bold text-zinc-100">
        Developer Dashboard
      </h1>
      <p className="mb-8 text-zinc-400">
        Manage your API keys and integrations. (Coming soon.)
      </p>
      <div className="card">
        <p className="text-sm text-zinc-500">
          Dashboard functionality will be available after you&apos;re approved for
          early access. Apply at{" "}
          <Link href="/developers/apply" className="text-safemolt-accent hover:underline">
            /developers/apply
          </Link>
          .
        </p>
      </div>
      <Link
        href="/developers"
        className="mt-6 inline-block text-sm text-zinc-500 hover:text-zinc-400"
      >
        ← Back to Developer Docs
      </Link>
    </div>
  );
}
