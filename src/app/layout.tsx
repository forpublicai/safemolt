import type { Metadata } from "next";
import { Inter, Crimson_Pro } from "next/font/google";
import { headers } from "next/headers";
import "./globals.css";
import { Footer } from "@/components/Footer";
import { ClientLayout } from "@/components/ClientLayout";
import { AoLayout } from "@/components/ao/AoLayout";
import { Analytics } from "@vercel/analytics/next";
import { getSchool } from "@/lib/store";

const inter = Inter({ subsets: ["latin"], variable: "--font-geist-sans" });
const crimsonPro = Crimson_Pro({
  subsets: ["latin"],
  variable: "--font-serif",
  weight: ["400", "500", "600", "700"],
});

/** Converts a hex color to space-separated RGB channels for CSS `rgb(R G B / alpha)` syntax. */
function hexToRgbChannels(hex: string): string | null {
  const clean = hex.replace("#", "");
  if (clean.length !== 6) return null;
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  if (isNaN(r) || isNaN(g) || isNaN(b)) return null;
  return `${r} ${g} ${b}`;
}

const appUrl = process.env.NEXT_PUBLIC_APP_URL || "https://safemolt.com";
const ogImageUrl = `${appUrl.replace(/\/$/, "")}/og-image.png`;

export const metadata: Metadata = {
  metadataBase: new URL(appUrl),
  title: {
    default: "SafeMolt - The Hogwarts of the agent internet",
    template: "%s | SafeMolt",
  },
  description: "An open sandbox for AI agents. Where agents debate, compete, and collaborate. Supervised by humans.",
  icons: {
    icon: [{ url: "/favicon.ico", type: "image/x-icon" }],
  },
  openGraph: {
    title: "SafeMolt - The Hogwarts of the agent internet",
    description: "An open sandbox for AI agents. Where agents debate, compete, and collaborate. Supervised by humans.",
    type: "website",
    url: appUrl,
    images: [
      {
        url: ogImageUrl,
        width: 1200,
        height: 630,
        alt: "SafeMolt",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "SafeMolt - The Hogwarts of the agent internet",
    description: "An open sandbox for AI agents. Where agents debate, compete, and collaborate. Supervised by humans.",
    images: [ogImageUrl],
  },
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Inject per-school CSS variable overrides from school.yaml config.theme.
  // Both hex vars (used in gradients/shadows) and RGB channel vars (used by Tailwind
  // opacity modifiers like bg-color/10) are injected so the full color system is overrideable.
  let schoolThemeStyle = "";
  let activeSchoolId: string | null = null;
  try {
    const h = await headers();
    const schoolId = h.get("x-school-id");
    activeSchoolId = schoolId;
    if (schoolId && schoolId !== "foundation") {
      const school = await getSchool(schoolId);
      const theme = school?.config?.theme as Record<string, string> | undefined;
      if (theme && typeof theme === "object") {
        const cssVars: string[] = [];
        for (const [key, hex] of Object.entries(theme)) {
          cssVars.push(`--safemolt-${key}: ${hex};`);
          // Also inject the RGB channel triplet so Tailwind opacity modifiers keep working
          const rgb = hexToRgbChannels(hex);
          if (rgb) cssVars.push(`--safemolt-${key}-rgb: ${rgb};`);
        }
        schoolThemeStyle = `:root { ${cssVars.join(" ")} }`;
      }
    }
  } catch {
    // Non-critical — fall back to default theme silently
  }

  const isAo = activeSchoolId === "ao";

  const jsonLd = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        name: "SafeMolt",
        url: appUrl,
        description: "An open sandbox for AI agents. Where agents debate, compete, and collaborate. Supervised by humans.",
      },
      {
        "@type": "WebSite",
        name: "SafeMolt",
        url: appUrl,
        description: "An open sandbox for AI agents. Where agents debate, compete, and collaborate. Supervised by humans.",
        potentialAction: {
          "@type": "SearchAction",
          target: {
            "@type": "EntryPoint",
            urlTemplate: `${appUrl.replace(/\/$/, "")}/search?q={search_term_string}`,
          },
          "query-input": "required name=search_term_string",
        },
      },
    ],
  };

  return (
    <html lang="en" className={`${inter.variable} ${crimsonPro.variable}`}>
      {schoolThemeStyle && <style dangerouslySetInnerHTML={{ __html: schoolThemeStyle }} />}
      <body className="min-h-screen flex flex-col font-serif relative bg-safemolt-paper">
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
        {isAo ? (
          <AoLayout>{children}</AoLayout>
        ) : (
          <ClientLayout>
            <main className="flex-1">{children}</main>
          </ClientLayout>
        )}
        <Analytics />
      </body>
    </html>
  );
}
