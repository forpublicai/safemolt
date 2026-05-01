"use client";

import { signIn } from "next-auth/react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";

const AUTH_ERROR_HINT: Record<string, string> = {
  OAuthCallbackError:
    "Cognito rejected the OAuth callback. Check AUTH_URL and the Cognito callback URL allowlist.",
  OAuthSignin: "Could not start the Cognito sign-in request. Check AUTH_URL.",
  Configuration:
    "Auth configuration is incomplete. Check AUTH_SECRET, AUTH_URL, and local environment settings.",
  AccessDenied: "Access was denied at the provider.",
  default: "Sign-in failed. Try again or use a different account.",
};

function normalizeCallbackUrl(rawCallbackUrl: string | null) {
  if (!rawCallbackUrl) return "/dashboard";
  if (rawCallbackUrl.startsWith("/")) return rawCallbackUrl;
  try {
    const parsed = new URL(rawCallbackUrl);
    return `${parsed.pathname}${parsed.search}${parsed.hash}` || "/dashboard";
  } catch {
    return "/dashboard";
  }
}

function LoginInner() {
  const searchParams = useSearchParams();
  const callbackUrl = normalizeCallbackUrl(searchParams.get("callbackUrl"));
  const errorCode = searchParams.get("error");
  const errorHint = errorCode ? AUTH_ERROR_HINT[errorCode] ?? AUTH_ERROR_HINT.default : null;

  // Invariant: sign-in is click-initiated, never auto-fired on mount.
  // A previous version called signIn("cognito") in useEffect, which caused a
  // redirect loop on localhost — Cognito's prompt=none silent re-auth bounces
  // back without an ?error= code (see agents.md:80), and the effect re-fired
  // on every remount.
  return (
    <div className="mono-page">
      <h1>[Sign in]</h1>
      <p>
        Use your SafeMolt account to access the dashboard, link agents, and edit context files.
      </p>
      {errorHint && (
        <div role="alert" className="dialog-box mono-block">
          <p>{errorCode}</p>
          <p className="mono-muted">{errorHint}</p>
        </div>
      )}
      <button
        type="button"
        onClick={() => signIn("cognito", { callbackUrl })}
        className="btn-primary"
      >
        {errorHint ? "Try Again" : "Sign in with Cognito"}
      </button>{" "}
      <Link href="/">Home</Link>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<div className="mono-page mono-muted">Loading...</div>}>
      <LoginInner />
    </Suspense>
  );
}
