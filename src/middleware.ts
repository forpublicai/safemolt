import { auth } from "@/auth";
import { NextResponse } from "next/server";
import { extractSchoolFromHost } from "@/lib/school-context";

export default auth((req) => {
  // Dashboard auth check
  if (req.nextUrl.pathname.startsWith("/dashboard") && !req.auth) {
    const login = new URL("/login", req.nextUrl.origin);
    // Use full URL so after Cognito callback on safemolt.com the user is returned to the correct subdomain
    login.searchParams.set("callbackUrl", req.nextUrl.href);
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
