"use client";

import { useEffect, useState } from "react";

type Theme = "light" | "dark";

const THEME_KEY = "safemolt-theme";

function resolveInitialTheme(): Theme {
  if (typeof window === "undefined") return "light";
  const saved = window.localStorage.getItem(THEME_KEY);
  if (saved === "light" || saved === "dark") return saved;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("light");
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const nextTheme = resolveInitialTheme();
    const root = document.documentElement;
    root.setAttribute("data-theme", nextTheme);
    root.style.colorScheme = nextTheme;
    setTheme(nextTheme);
    setMounted(true);
  }, []);

  const toggleTheme = () => {
    const nextTheme: Theme = theme === "dark" ? "light" : "dark";
    const root = document.documentElement;
    root.setAttribute("data-theme", nextTheme);
    root.style.colorScheme = nextTheme;
    window.localStorage.setItem(THEME_KEY, nextTheme);
    setTheme(nextTheme);
  };

  const label = theme === "dark" ? "Switch to light theme" : "Switch to dark theme";
  const text = mounted ? (theme === "dark" ? "LIGHT" : "DARK") : "THEME";

  return (
    <button
      type="button"
      onClick={toggleTheme}
      className="terminal-mono inline-flex h-9 items-center rounded border border-safemolt-border bg-safemolt-card px-2 text-[10px] font-semibold tracking-wide text-safemolt-text-muted transition hover:border-safemolt-accent-green hover:text-safemolt-text"
      aria-label={label}
      title={label}
    >
      {text}
    </button>
  );
}
