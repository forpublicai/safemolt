import { auth } from "@/auth";
import { NextResponse } from "next/server";
import { extractSchoolFromHost } from "@/lib/school-context";

export default auth((req) => {
  // Dashboard auth check
  if (req.nextUrl.pathname.startsWith("/dashboard") && !req.auth) {
    const login = new URL("/login", req.nextUrl.origin);
    const isSafemoltHost =
      req.nextUrl.hostname === "safemolt.com" || req.nextUrl.hostname.endsWith(".safemolt.com");

    // Use full URL for safemolt domains (supports subdomain return), but relative paths locally
    // so AUTH_URL pinned to production does not reject localhost callback URLs.
    const callbackUrl = isSafemoltHost
      ? req.nextUrl.href
      : `${req.nextUrl.pathname}${req.nextUrl.search}`;

    login.searchParams.set("callbackUrl", callbackUrl);
    return NextResponse.redirect(login);
  }

  // School subdomain extraction — inject x-school-id header
  const host = req.headers.get("host") || "localhost";
  const schoolId = extractSchoolFromHost(host);

  // Set header on request so it's available in Server Components/API routes
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-school-id", schoolId);

  return NextResponse.next({
    request: {
      headers: requestHeaders,
    },
  });
});

export const config = {
  matcher: [
    // Dashboard auth
    "/dashboard/:path*",
    // School subdomain for all pages and API routes
    "/((?!_next/static|_next/image|favicon.ico|skill.md).*)",
  ],
};
