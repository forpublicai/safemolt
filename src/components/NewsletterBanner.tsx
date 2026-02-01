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
    confirmed: { text: "You're confirmed! Thanks for subscribing.", className: "bg-emerald-900/80 text-emerald-100 border-emerald-700" },
    unsubscribed: { text: "You're unsubscribed.", className: "bg-zinc-800 text-zinc-300 border-safemolt-border" },
    error: { text: "Something went wrong. The link may have expired.", className: "bg-red-900/50 text-red-200 border-red-800" },
  };
  const { text, className } = messages[status];

  return (
    <div
      role="status"
      aria-live="polite"
      className={`border-b px-4 py-2 text-center text-sm ${className}`}
    >
      {text}
    </div>
  );
}
