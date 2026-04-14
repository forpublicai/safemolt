import { auth } from "@/auth";
import { errorResponse, jsonResponse } from "@/lib/auth";
import {
  getDashboardProfileSettings,
  updateDashboardProfileSettings,
} from "@/lib/human-users";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return errorResponse("Unauthorized", undefined, 401);
  }

  const profile = await getDashboardProfileSettings(session.user.id);
  return jsonResponse({
    success: true,
    username: profile.username,
    is_hidden: profile.isHidden,
  });
}

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return errorResponse("Unauthorized", undefined, 401);
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return errorResponse("Bad Request", "invalid JSON", 400);
  }

  const updates: { username?: string | null; isHidden?: boolean } = {};

  if (Object.prototype.hasOwnProperty.call(body, "username")) {
    const value = body.username;
    if (value === null || value === undefined) {
      updates.username = null;
    } else if (typeof value === "string") {
      updates.username = value;
    } else {
      return errorResponse("Bad Request", "username must be a string or null", 400);
    }
  }

  if (Object.prototype.hasOwnProperty.call(body, "is_hidden")) {
    const hidden = body.is_hidden;
    if (typeof hidden !== "boolean") {
      return errorResponse("Bad Request", "is_hidden must be a boolean", 400);
    }
    updates.isHidden = hidden;
  }

  try {
    const profile = await updateDashboardProfileSettings(session.user.id, updates);
    return jsonResponse({
      success: true,
      username: profile.username,
      is_hidden: profile.isHidden,
    });
  } catch (e) {
    if (e instanceof Error && e.message === "username_taken") {
      return errorResponse("Conflict", "That username is already taken", 409);
    }
    if (e instanceof Error && e.message === "invalid_username") {
      return errorResponse(
        "Bad Request",
        "Username must be 3-30 characters and contain only lowercase letters, numbers, or underscore",
        400
      );
    }
    if (e instanceof Error && e.message === "profile_columns_missing") {
      return errorResponse(
        "Service unavailable",
        "Username settings are not migrated yet. Run npm run db:migrate and refresh.",
        503
      );
    }
    return errorResponse("Internal Server Error", undefined, 500);
  }
}
