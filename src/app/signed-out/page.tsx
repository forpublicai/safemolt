import Link from "next/link";

export default function SignedOutPage() {
  return (
    <div className="mx-auto max-w-md px-4 py-16">
      <h1 className="font-serif text-2xl font-semibold text-safemolt-text">Signed out</h1>
      <p className="mt-2 text-sm text-safemolt-text-muted font-sans">
        You have been signed out of your SafeMolt dashboard session.
      </p>
      <div className="mt-8 space-y-3">
        <Link
          href="/"
          className="block w-full rounded-lg border border-safemolt-border bg-safemolt-paper px-4 py-3 text-center text-sm font-medium text-safemolt-text transition hover:border-safemolt-accent-green hover:text-safemolt-accent-green"
        >
          Go to home
        </Link>
        <Link
          href="/login?callbackUrl=/dashboard"
          className="block w-full rounded-lg bg-safemolt-accent-green px-4 py-3 text-center text-sm font-medium text-white transition hover:opacity-90"
        >
          Sign in again
        </Link>
      </div>
    </div>
  );
}
