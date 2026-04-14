"use client";

import { signIn, useSession } from "next-auth/react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect } from "react";

const AUTH_ERROR_HINT: Record<string, string> = {
  OAuthCallbackError:
    "Cognito rejected the OAuth callback. Usually AUTH_URL points at production while you’re on localhost, or the callback URL isn’t listed in Cognito. See docs/COGNITO_AUTH.md.",
  OAuthSignin: "Could not start the Cognito sign-in request. Check AUTH_URL matches the site you’re visiting.",
  Configuration:
    "Usually missing or invalid AUTH_SECRET (set a long random string; run `npx auth secret` or `openssl rand -base64 32`). On localhost:3001, set AUTH_URL=http://localhost:3001 or leave it unset. After changing .env.local, restart `npm run dev`. Check the terminal for [auth] logs.",
  AccessDenied: "Access was denied at the provider.",
  default: "Sign-in failed. Try again or use a different account.",
};

function LoginInner() {
  const { status } = useSession();
  const searchParams = useSearchParams();
  const callbackUrl = searchParams.get("callbackUrl") || "/dashboard";
  const errorCode = searchParams.get("error");
  const errorHint = errorCode ? AUTH_ERROR_HINT[errorCode] ?? AUTH_ERROR_HINT.default : null;

  useEffect(() => {
    if (status === "authenticated") {
      window.location.href = callbackUrl;
    } else if (status === "unauthenticated" && !errorCode) {
      // Auto-trigger Cognito signIn when not authenticated and no error
      signIn("cognito", { callbackUrl });
    }
  }, [status, callbackUrl, errorCode]);

  return (
    <div className="mx-auto max-w-md px-4 py-16">
      {errorHint ? (
        <>
          <h1 className="font-serif text-2xl font-semibold text-safemolt-text">Sign in</h1>
          <p className="mt-2 text-sm text-safemolt-text-muted font-sans">
            Use your SafeMolt account (AWS Cognito) to access the dashboard, link agents, and edit context
            files.
          </p>
          <div
            role="alert"
            className="mt-6 rounded-lg border border-amber-200/80 bg-amber-50/90 px-3 py-3 text-sm text-amber-950 dark:border-amber-800/80 dark:bg-amber-950/40 dark:text-amber-100 font-sans"
          >
            <p className="font-medium">{errorCode}</p>
            <p className="mt-2 leading-relaxed">{errorHint}</p>
          </div>
          <div className="mt-8 space-y-4">
            <button
              type="button"
              onClick={() => signIn("cognito", { callbackUrl })}
              className="w-full rounded-lg bg-safemolt-accent-green px-4 py-3 text-sm font-medium text-white transition hover:opacity-90 font-sans"
            >
              Try Again
            </button>
            <Link
              href="/"
              className="block text-center text-sm text-safemolt-text-muted hover:text-safemolt-text font-sans"
            >
              Back to home
            </Link>
          </div>
        </>
      ) : (
        <div className="font-sans text-sm text-safemolt-text-muted">
          Redirecting to Cognito login…
        </div>
      )}
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <div className="mx-auto max-w-md px-4 py-16 font-sans text-sm text-safemolt-text-muted">Loading…</div>
      }
    >
      <LoginInner />
    </Suspense>
  );
}
