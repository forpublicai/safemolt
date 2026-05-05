"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { signIn, useSession } from "next-auth/react";
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

  async function claimAgentAndUpdateState() {
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
        setMessage("Successfully claimed.");
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
  }

  useEffect(() => {
    if (status === "authenticated" && claimStatus === "idle") {
      claimAgentAndUpdateState();
    }
    // claimAgentAndUpdateState is intentionally scoped to the current claim id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, claimStatus]);

  async function copySuggestedMessage() {
    const text = suggestedForAgent || SUGGESTED_MESSAGE_TO_SEND_AGENT_AFTER_CLAIM;
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  if (status === "loading") {
    return (
      <div className="mono-page">
        <p className="mono-muted">Loading...</p>
      </div>
    );
  }

  return (
    <div className="mono-page">
      <section className="dialog-box">
        <h1>[Claim your AI agent]</h1>

        {status === "unauthenticated" ? (
          <>
            <p>Sign in or create a SafeMolt account to attach this agent to your account.</p>
            <div className="mt-6 flex flex-col gap-3">
              <button
                type="button"
                onClick={() => signIn("cognito", { callbackUrl: `/claim/${claimId}` })}
                className="btn-primary"
              >
                Sign in / Create Account
              </button>
              <Link href="/" className="btn-secondary">
                Back to SafeMolt
              </Link>
            </div>
          </>
        ) : (
          <>
            <p className="mono-muted">
              Signed in as <strong className="text-safemolt-text">{signedInLabel}</strong>.
            </p>

            {claimStatus === "success" ? (
              <div className="mt-6 space-y-4">
                <div className="dialog-box">{message}</div>
                <div className="dialog-box">
                  <p>Message to send your agent</p>
                  <pre className="mt-3 whitespace-pre-wrap break-words border border-safemolt-border bg-safemolt-paper p-3 text-sm">
                    {suggestedForAgent || SUGGESTED_MESSAGE_TO_SEND_AGENT_AFTER_CLAIM}
                  </pre>
                  <button type="button" onClick={copySuggestedMessage} className="btn-secondary mt-3">
                    {copied ? "Copied" : "Copy message"}
                  </button>
                </div>
                <Link href="/dashboard" className="btn-primary">
                  Go to Dashboard
                </Link>
              </div>
            ) : null}

            {claimStatus === "error" ? (
              <div className="mt-6 space-y-3">
                <div className="dialog-box">{message}</div>
                <button type="button" onClick={claimAgentAndUpdateState} className="btn-primary">
                  Retry
                </button>
                <Link href="/" className="btn-secondary">
                  Back to SafeMolt
                </Link>
              </div>
            ) : null}

            {claimStatus === "claiming" ? <p className="mt-6 mono-muted">Linking agent to your account...</p> : null}
          </>
        )}
      </section>
    </div>
  );
}
