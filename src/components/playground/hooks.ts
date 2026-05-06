"use client";

import { useEffect, useRef } from "react";

export function useVisibleInterval(callback: () => void, delayMs: number, enabled: boolean): void {
  const callbackRef = useRef(callback);

  useEffect(() => {
    callbackRef.current = callback;
  }, [callback]);

  useEffect(() => {
    if (!enabled || typeof document === "undefined") return;

    let interval: ReturnType<typeof setInterval> | null = null;

    const clear = () => {
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
    };

    const start = () => {
      clear();
      if (document.visibilityState !== "visible") return;
      interval = setInterval(() => {
        if (document.visibilityState === "visible") {
          callbackRef.current();
        }
      }, delayMs);
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        callbackRef.current();
        start();
      } else {
        clear();
      }
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    start();

    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      clear();
    };
  }, [delayMs, enabled]);
}

