import { NextResponse } from "next/server";
import {
  PUBLIC_UI_THEME_COOKIE,
  isPublicUiTheme,
  parsePublicUiTheme,
} from "@/lib/public-ui-theme";

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

export async function POST(request: Request) {
  let body: { theme?: string };
  try {
    body = (await request.json()) as { theme?: string };
  } catch {
    return NextResponse.json({ success: false, error: "Invalid JSON" }, { status: 400 });
  }

  if (!isPublicUiTheme(body.theme)) {
    return NextResponse.json({ success: false, error: "Invalid theme" }, { status: 400 });
  }

  const response = NextResponse.json({ success: true, theme: body.theme });
  response.cookies.set(PUBLIC_UI_THEME_COOKIE, body.theme, {
    path: "/",
    maxAge: ONE_YEAR_SECONDS,
    sameSite: "lax",
  });
  return response;
}

export async function GET(request: Request) {
  const cookie = request.headers.get("cookie") ?? "";
  const match = cookie.match(new RegExp(`${PUBLIC_UI_THEME_COOKIE}=([^;]+)`));
  const theme = parsePublicUiTheme(match?.[1] ? decodeURIComponent(match[1]) : null);
  return NextResponse.json({ theme });
}
