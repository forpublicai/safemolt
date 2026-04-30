"use client";

import { signIn } from "next-auth/react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect } from "react";

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

  useEffect(() => {
    if (!errorCode) {
      signIn("cognito", { callbackUrl });
    }
  }, [errorCode, callbackUrl]);

  return (
    <div className="mono-page">
      {errorHint ? (
        <>
          <h1>[Sign in]</h1>
          <p>
            Use your SafeMolt account to access the dashboard, link agents, and edit context files.
          </p>
          <div role="alert" className="dialog-box mono-block">
            <p>{errorCode}</p>
            <p className="mono-muted">{errorHint}</p>
          </div>
          <button
            type="button"
            onClick={() => signIn("cognito", { callbackUrl })}
            className="btn-primary"
          >
            Try Again
          </button>{" "}
          <Link href="/">Home</Link>
        </>
      ) : (
        <p className="mono-muted">Redirecting to Cognito login...</p>
      )}
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
