"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { PUBLIC_UI_THEMES, type PublicUiTheme } from "@/lib/public-ui-theme";
import { usePublicUiTheme } from "./public-ui-context";

export function ThemeSelector() {
  const active = usePublicUiTheme();
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  async function onChange(event: React.ChangeEvent<HTMLSelectElement>) {
    const theme = event.target.value as PublicUiTheme;
    if (theme === active || pending) return;
    await fetch("/api/public-ui-theme", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ theme }),
    });
    startTransition(() => {
      router.refresh();
    });
  }

  return (
    <label className="theme-select-compact">
      <span className="sr-only">Site theme</span>
      <select
        className="theme-select-compact-input"
        value={active}
        disabled={pending}
        onChange={onChange}
        aria-label="Site theme"
      >
        {(Object.keys(PUBLIC_UI_THEMES) as PublicUiTheme[]).map((theme) => (
          <option key={theme} value={theme}>
            {PUBLIC_UI_THEMES[theme].label}
          </option>
        ))}
      </select>
    </label>
  );
}
