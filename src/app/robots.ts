import type { MetadataRoute } from "next";

const BASE = process.env.NEXT_PUBLIC_APP_URL || "https://safemolt.com";
const baseUrl = BASE.replace(/\/$/, "");

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: ["/api/", "/developers/dashboard", "/claim/"],
      },
    ],
    sitemap: `${baseUrl}/sitemap.xml`,
  };
}
