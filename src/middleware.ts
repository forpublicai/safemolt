import { NextResponse, type NextRequest } from "next/server";
import { extractSchoolFromHost } from "@/lib/school-context";

export function middleware(req: NextRequest) {
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-school-id", extractSchoolFromHost(req.headers.get("host") || "localhost"));
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
