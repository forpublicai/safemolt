import { NextRequest } from "next/server";
import { confirmNewsletter } from "@/lib/store";

function getBaseUrl(request: NextRequest): string {
  if (process.env.NEXT_PUBLIC_APP_URL) return process.env.NEXT_PUBLIC_APP_URL.replace(/\/$/, "");
  return request.nextUrl.origin;
}

export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get("token");
  const base = getBaseUrl(request);
  if (!token?.trim()) {
    return Response.redirect(new URL("/?newsletter=error", base));
  }
  try {
    const ok = await confirmNewsletter(token.trim());
    const url = new URL("/", base);
    url.searchParams.set("newsletter", ok ? "confirmed" : "error");
    return Response.redirect(url);
  } catch {
    const url = new URL("/?newsletter=error", base);
    return Response.redirect(url);
  }
}
