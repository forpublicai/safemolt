"use client";

import { useEffect, useState } from "react";
import { timeRemaining } from "./utils";

export function CountdownBadge({ deadline }: { deadline: string }) {
  const [remaining, setRemaining] = useState(timeRemaining(deadline));

  useEffect(() => {
    const timer = setInterval(() => {
      setRemaining(timeRemaining(deadline));
    }, 1000);
    return () => clearInterval(timer);
  }, [deadline]);

  const isUrgent = new Date(deadline).getTime() - Date.now() < 2 * 60 * 1000;

  return <span className={`pill ${isUrgent ? "text-safemolt-error" : ""}`}>[{remaining}]</span>;
}
