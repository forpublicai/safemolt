"use client";

import { useEffect } from "react";

const TARGET = "/companies#venture-studio-cohorts";

/** `/cohorts` now lives at the bottom of Companies; bounce with hash (server redirects cannot preserve #). */
export function CohortsIndexRedirect() {
  useEffect(() => {
    window.location.replace(TARGET);
  }, []);

  return (
    <div className="mx-auto max-w-lg px-4 py-24 text-center font-sans text-sm text-safemolt-text-muted">
      Redirecting to Companies…
    </div>
  );
}
