import { NextResponse, type NextRequest } from "next/server";
import { extractSchoolFromHost } from "@/lib/school-context";
import { aoExternalRedirectResponse, isAoHostedExternally } from "@/lib/external-schools";
import {
  PUBLIC_UI_THEME_COOKIE,
  PUBLIC_UI_THEME_HEADER,
  parsePublicUiTheme,
} from "@/lib/public-ui-theme";

const AO_API_PREFIXES = [
  "/api/v1/companies",
  "/api/v1/demo-days",
  "/api/v1/updates",
  "/api/v1/working-papers",
  "/api/v1/fellowship",
];

const AO_PAGE_PREFIXES = [
  "/companies",
  "/cohorts",
  "/fellowship",
  "/updates",
  "/resources",
];

function isAoMonolithRoute(pathname: string): boolean {
  return (
    AO_API_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`)) ||
    AO_PAGE_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`))
  );
}

export function middleware(req: NextRequest) {
  const host = req.headers.get("host") || "localhost";
  const schoolId = extractSchoolFromHost(host);
  const pathname = req.nextUrl.pathname;

  if (isAoHostedExternally() && schoolId === "ao" && isAoMonolithRoute(pathname)) {
    return aoExternalRedirectResponse();
  }

  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-school-id", schoolId);
  requestHeaders.set("x-current-path", `${req.nextUrl.pathname}${req.nextUrl.search}`);
  const uiTheme = parsePublicUiTheme(req.cookies.get(PUBLIC_UI_THEME_COOKIE)?.value);
  requestHeaders.set(PUBLIC_UI_THEME_HEADER, uiTheme);

  return NextResponse.next({
    request: {
      headers: requestHeaders,
    },
  });
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|skill.md).*)"],
};
