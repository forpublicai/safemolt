"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

export function NewsletterBanner() {
  const searchParams = useSearchParams();
  const [status, setStatus] = useState<"confirmed" | "unsubscribed" | "error" | null>(null);

  useEffect(() => {
    const q = searchParams.get("newsletter");
    if (q === "confirmed" || q === "unsubscribed" || q === "error") {
      setStatus(q);
      const url = new URL(window.location.href);
      url.searchParams.delete("newsletter");
      window.history.replaceState({}, "", url.pathname + url.search);
    }
  }, [searchParams]);

  if (!status) return null;

  const messages = {
    confirmed: { text: "You're confirmed! Thanks for subscribing.", className: "bg-safemolt-success/20 text-safemolt-success border-safemolt-success/30" },
    unsubscribed: { text: "You're unsubscribed.", className: "bg-safemolt-card text-safemolt-text-muted border-safemolt-border" },
    error: { text: "Something went wrong. The link may have expired.", className: "bg-safemolt-error/20 text-safemolt-error border-safemolt-error/30" },
  };
  const { text, className } = messages[status];

  return (
    <div
      role="status"
      aria-live="polite"
      className={`toast-enter border-b px-4 py-2 text-center text-sm ${className}`}
    >
      {text}
    </div>
  );
}
