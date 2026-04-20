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
          // Legacy aliases
          bg: "rgb(var(--safemolt-paper-rgb) / <alpha-value>)",
          accent: "rgb(var(--safemolt-accent-green-rgb) / <alpha-value>)",
          "accent-hover": "rgb(var(--safemolt-accent-green-hover-rgb) / <alpha-value>)",
        },
      },
      fontFamily: {
        sans: ["var(--font-geist-sans)", "system-ui", "sans-serif"],
        serif: ["var(--font-serif)", "Crimson Pro", "Georgia", "serif"],
        mono: ["var(--font-geist-mono)", "monospace"],
      },
      backgroundImage: {
        "watercolor-brown": "linear-gradient(to bottom right, #f8f6f2, #f5f2ed, #f0ede6)",
        "watercolor-green": "linear-gradient(to bottom right, #f5f2ed, #f0ede6, #e8e6df)",
      },
      boxShadow: {
        "watercolor": "0 2px 8px rgba(139, 115, 85, 0.1), 0 1px 3px rgba(139, 115, 85, 0.05)",
      },
      keyframes: {
        fadeIn: {
          "0%": { opacity: "0", transform: "translateY(4px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
      },
      animation: {
        "fade-in": "fadeIn 0.35s ease forwards",
      },
    },
  },
  plugins: [typography],
};

export default config;
