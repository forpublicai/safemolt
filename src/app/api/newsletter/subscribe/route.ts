import { NextRequest } from "next/server";
import { subscribeNewsletter } from "@/lib/store";
import { isEmailConfigured, sendNewsletterConfirmation } from "@/lib/email";

const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 5;
const ipCounts = new Map<string, { count: number; resetAt: number }>();

function getClientIp(request: NextRequest): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown"
  );
}

function checkRateLimit(ip: string): { allowed: boolean; retryAfterSeconds?: number } {
  const now = Date.now();
  const entry = ipCounts.get(ip);
  if (!entry) return { allowed: true };
  if (now >= entry.resetAt) {
    ipCounts.delete(ip);
    return { allowed: true };
  }
  if (entry.count >= RATE_LIMIT_MAX) {
    return {
      allowed: false,
      retryAfterSeconds: Math.ceil((entry.resetAt - now) / 1000),
    };
  }
  return { allowed: true };
}

function recordRequest(ip: string): void {
  const now = Date.now();
  const entry = ipCounts.get(ip);
  if (!entry) {
    ipCounts.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return;
  }
  entry.count += 1;
}

function isValidEmail(value: string): boolean {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed || trimmed.length > 254) return false;
  const at = trimmed.indexOf("@");
  if (at <= 0 || at === trimmed.length - 1) return false;
  const dot = trimmed.indexOf(".", at + 1);
  if (dot <= at + 1 || dot === trimmed.length - 1) return false;
  return true;
}

export async function POST(request: NextRequest) {
  const ip = getClientIp(request);
  const limit = checkRateLimit(ip);
  if (!limit.allowed) {
    return Response.json(
      {
        success: false,
        error: "Too many requests",
        retry_after_seconds: limit.retryAfterSeconds,
      },
      { status: 429 }
    );
  }

  let body: { email?: string; source?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { success: false, error: "Invalid JSON" },
      { status: 400 }
    );
  }

  const rawEmail = typeof body?.email === "string" ? body.email : "";
  if (!isValidEmail(rawEmail)) {
    return Response.json(
      { success: false, error: "Invalid email" },
      { status: 400 }
    );
  }

  const source = typeof body?.source === "string" ? body.source.slice(0, 100) : undefined;
  recordRequest(ip);

  const normalized = rawEmail.trim().toLowerCase();

  try {
    const { token } = await subscribeNewsletter(normalized, source ?? "homepage");

    const baseUrl =
      request.headers.get("x-forwarded-proto") && request.headers.get("x-forwarded-host")
        ? `${request.headers.get("x-forwarded-proto")}://${request.headers.get("x-forwarded-host")}`
        : request.nextUrl.origin;

    if (isEmailConfigured()) {
      const sent = await sendNewsletterConfirmation(baseUrl, normalized, token);
      if (!sent.ok) console.error("Newsletter confirmation email failed:", sent.error);
    }

    const message = isEmailConfigured()
      ? "You're on the list. Check your email to confirm."
      : "You're on the list.";
    return Response.json({
      success: true,
      message,
    });
  } catch (err) {
    console.error("Newsletter subscribe error:", err);
    return Response.json(
      { success: false, error: "Something went wrong. Please try again later." },
      { status: 500 }
    );
  }
}
