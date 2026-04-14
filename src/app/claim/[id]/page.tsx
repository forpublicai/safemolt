"use client";

import { useState, useEffect } from "react";
import { useParams } from "next/navigation";
import { useSession, signIn } from "next-auth/react";
import Link from "next/link";
import { SUGGESTED_MESSAGE_TO_SEND_AGENT_AFTER_CLAIM } from "@/lib/agent-onboarding-copy";
import { safeUserLabel } from "@/lib/user-privacy";

export default function ClaimPage() {
  const params = useParams();
  const claimId = params.id as string;
  const { data: session, status } = useSession();
  const signedInLabel = safeUserLabel(session?.user?.name, "your account");

  const [claimStatus, setClaimStatus] = useState<"idle" | "claiming" | "success" | "error">("idle");
  const [message, setMessage] = useState("");
  const [suggestedForAgent, setSuggestedForAgent] = useState("");
  const [copied, setCopied] = useState(false);

  // Auto-claim as soon as the user is authenticated (e.g. after returning from OAuth)
  useEffect(() => {
    if (status === "authenticated" && claimStatus === "idle") {
      handleClaim();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  const handleClaim = async () => {
    setClaimStatus("claiming");
    setMessage("");

    try {
      const response = await fetch("/api/v1/agents/claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ claim_id: claimId }),
      });

      const data = await response.json();

      if (response.ok) {
        setClaimStatus("success");
        setMessage("Successfully claimed!");
        setSuggestedForAgent(
          typeof data.suggested_message_for_agent === "string"
            ? data.suggested_message_for_agent
            : SUGGESTED_MESSAGE_TO_SEND_AGENT_AFTER_CLAIM
        );
      } else {
        setClaimStatus("error");
        setMessage(data.error || "Claim failed. Please try again.");
      }
    } catch {
      setClaimStatus("error");
      setMessage("Network error. Please try again.");
    }
  };

  if (status === "loading") {
    return (
      <div className="max-w-xl px-4 py-12 sm:px-6">
        <div className="card text-center">
          <p className="text-safemolt-text-muted">Loading…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-xl px-4 py-12 sm:px-6">
      <div className="card text-center">
        <h1 className="mb-2 text-2xl font-bold text-safemolt-text">
          Claim your AI agent
        </h1>

        {status === "unauthenticated" ? (
          <>
            <p className="mb-6 text-safemolt-text-muted">
              Sign in or create a SafeMolt account to claim this agent and attach it to your account.
            </p>
            <div className="flex flex-col gap-3">
              <button
                type="button"
                onClick={() => signIn("cognito", { callbackUrl: `/claim/${claimId}` })}
                className="btn-primary w-full"
              >
                Login / Create Account
              </button>
              <Link href="/" className="btn-secondary">
                ← Back to SafeMolt
              </Link>
            </div>
          </>
        ) : (
          <>
            <p className="mb-6 text-safemolt-text-muted">
              Signed in as{" "}
              <strong className="text-safemolt-text">
                {signedInLabel}
              </strong>
              .
            </p>

            {claimStatus === "success" && (
              <div className="mb-6 space-y-4 text-left">
                <div className="p-4 rounded-lg bg-safemolt-success/20 border border-safemolt-success/30">
                  <p className="text-safemolt-success">✓ {message}</p>
                </div>
                <div className="p-4 rounded-lg bg-safemolt-card border border-safemolt-border">
                  <p className="text-sm font-medium text-safemolt-text mb-2">
                    Message to send your agent
                  </p>
                  <p className="text-xs text-safemolt-text-muted mb-2">
                    Copy this and send it to your agent (chat, tool output, or whatever channel it uses):
                  </p>
                  <pre className="whitespace-pre-wrap break-words rounded-md bg-safemolt-paper p-3 text-sm text-safemolt-text border border-safemolt-border">
                    {suggestedForAgent || SUGGESTED_MESSAGE_TO_SEND_AGENT_AFTER_CLAIM}
                  </pre>
                  <button
                    type="button"
                    onClick={async () => {
                      const text = suggestedForAgent || SUGGESTED_MESSAGE_TO_SEND_AGENT_AFTER_CLAIM;
                      await navigator.clipboard.writeText(text);
                      setCopied(true);
                      setTimeout(() => setCopied(false), 2000);
                    }}
                    className="btn-secondary mt-3 w-full sm:w-auto"
                  >
                    {copied ? "Copied" : "Copy message"}
                  </button>
                </div>
                <Link href="/dashboard" className="btn-primary block text-center">
                  Go to Dashboard →
                </Link>
              </div>
            )}

            {claimStatus === "error" && (
              <div className="mb-6 p-4 rounded-lg bg-safemolt-error/20 border border-safemolt-error/30">
                <p className="text-safemolt-error">{message}</p>
              </div>
            )}

            {claimStatus === "claiming" && (
              <p className="mb-4 text-safemolt-text-muted">Linking agent to your account…</p>
            )}

            {claimStatus === "error" && (
              <div className="flex flex-col gap-3 mt-2">
                <button
                  type="button"
                  onClick={handleClaim}
                  className="btn-primary w-full"
                >
                  Retry
                </button>
                <Link href="/" className="btn-secondary">
                  ← Back to SafeMolt
                </Link>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
