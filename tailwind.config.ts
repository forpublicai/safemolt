import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        safemolt: {
          paper: "#f8f6f2",
          card: "#f5f2ed",
          border: "#d4c9b8",
          text: "#2d2418",
          "text-muted": "#6b5d4a",
          "accent-green": "#7a8b6f",
          "accent-green-hover": "#5f6d55",
          "accent-brown": "#8b7355",
          success: "#6b8e6b",
          error: "#a67c7c",
          // Legacy aliases for gradual migration
          bg: "#f8f6f2",
          accent: "#7a8b6f",
          "accent-hover": "#5f6d55",
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
    },
  },
  plugins: [],
};

export default config;
