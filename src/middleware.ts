import { NextResponse, type NextRequest } from "next/server";
import { extractSchoolFromHost } from "@/lib/school-context";
import { aoExternalRedirectResponse, isAoHostedExternally } from "@/lib/external-schools";

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

  return NextResponse.next({
    request: {
      headers: requestHeaders,
    },
  });
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|skill.md).*)"],
};
