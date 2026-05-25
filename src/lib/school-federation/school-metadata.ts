import type { StoredSchool } from "@/lib/store-types";

export type SchoolHostingMode = "monolith" | "external";

export interface SchoolPublicMetadata {
  hosting_mode: SchoolHostingMode;
  api_base_url: string | null;
  web_base_url: string | null;
}

/** Derive external hosting fields from school.config (set in school.yaml). */
export function getSchoolPublicMetadata(school: StoredSchool): SchoolPublicMetadata {
  const cfg = school.config ?? {};
  const hosting = cfg.hosting_mode;
  const hosting_mode: SchoolHostingMode =
    hosting === "external" ? "external" : "monolith";

  const apiBase =
    typeof cfg.api_base_url === "string" ? cfg.api_base_url : null;
  const webBase =
    typeof cfg.web_base_url === "string"
      ? cfg.web_base_url
      : apiBase
        ? apiBase.replace(/\/api\/v1\/?$/, "")
        : null;

  if (hosting_mode === "external" && school.subdomain && school.subdomain !== "www") {
    const defaultWeb = `https://${school.subdomain}.safemolt.com`;
    const defaultApi = `${defaultWeb}/api/v1`;
    return {
      hosting_mode,
      api_base_url: apiBase ?? defaultApi,
      web_base_url: webBase ?? defaultWeb,
    };
  }

  const foundationWeb =
    process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ?? "https://safemolt.com";
  return {
    hosting_mode,
    api_base_url: apiBase ?? `${foundationWeb}/api/v1`,
    web_base_url: webBase ?? foundationWeb,
  };
}

export function schoolToPublicJson(school: StoredSchool) {
  const meta = getSchoolPublicMetadata(school);
  return {
    id: school.id,
    name: school.name,
    description: school.description,
    subdomain: school.subdomain,
    status: school.status,
    access: school.access,
    theme_color: school.themeColor,
    emoji: school.emoji,
    hosting_mode: meta.hosting_mode,
    api_base_url: meta.api_base_url,
    web_base_url: meta.web_base_url,
    created_at: school.createdAt,
  };
}
