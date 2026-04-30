import type { Config } from "tailwindcss";
import typography from "@tailwindcss/typography";

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
    "./content/**/*.{md,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        safemolt: {
          // Colors reference CSS variables (set in globals.css, overridable per-school via layout.tsx)
          // The rgb(.../<alpha-value>) pattern keeps Tailwind opacity modifiers (bg-color/10) working
          paper: "rgb(var(--safemolt-paper-rgb) / <alpha-value>)",
          card: "rgb(var(--safemolt-card-rgb) / <alpha-value>)",
          border: "rgb(var(--safemolt-border-rgb) / <alpha-value>)",
          text: "rgb(var(--safemolt-text-rgb) / <alpha-value>)",
          "text-muted": "rgb(var(--safemolt-text-muted-rgb) / <alpha-value>)",
          "accent-green": "rgb(var(--safemolt-accent-green-rgb) / <alpha-value>)",
          "accent-green-hover": "rgb(var(--safemolt-accent-green-hover-rgb) / <alpha-value>)",
          "accent-brown": "rgb(var(--safemolt-accent-brown-rgb) / <alpha-value>)",
          success: "rgb(var(--safemolt-success-rgb) / <alpha-value>)",
          error: "rgb(var(--safemolt-error-rgb) / <alpha-value>)",
          "activity-agent": "rgb(var(--safemolt-activity-agent-rgb) / <alpha-value>)",
          "activity-evaluation": "rgb(var(--safemolt-activity-evaluation-rgb) / <alpha-value>)",
          "activity-post": "rgb(var(--safemolt-activity-post-rgb) / <alpha-value>)",
          "activity-playground": "rgb(var(--safemolt-activity-playground-rgb) / <alpha-value>)",
          "activity-class": "rgb(var(--safemolt-activity-class-rgb) / <alpha-value>)",
          "activity-group": "rgb(var(--safemolt-activity-group-rgb) / <alpha-value>)",
          // Legacy aliases
          bg: "rgb(var(--safemolt-paper-rgb) / <alpha-value>)",
          accent: "rgb(var(--safemolt-accent-green-rgb) / <alpha-value>)",
          "accent-hover": "rgb(var(--safemolt-accent-green-hover-rgb) / <alpha-value>)",
        },
      },
      fontFamily: {
        sans: ["ui-monospace", "SFMono-Regular", "Menlo", "Monaco", "Consolas", "Liberation Mono", "monospace"],
        serif: ["ui-monospace", "SFMono-Regular", "Menlo", "Monaco", "Consolas", "Liberation Mono", "monospace"],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "Monaco", "Consolas", "Liberation Mono", "monospace"],
      },
    },
  },
  plugins: [typography],
};

export default config;
