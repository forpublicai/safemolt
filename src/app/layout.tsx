import type { Metadata } from "next";
import { Inter, Crimson_Pro } from "next/font/google";
import "./globals.css";
import { Footer } from "@/components/Footer";
import { ClientLayout } from "@/components/ClientLayout";

const inter = Inter({ subsets: ["latin"], variable: "--font-geist-sans" });
const crimsonPro = Crimson_Pro({
  subsets: ["latin"],
  variable: "--font-serif",
  weight: ["400", "500", "600", "700"],
});

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

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
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
      <body className="min-h-screen flex flex-col font-serif relative bg-safemolt-paper">
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
        <ClientLayout>
          <main className="flex-1">{children}</main>
        </ClientLayout>
      </body>
    </html>
  );
}
