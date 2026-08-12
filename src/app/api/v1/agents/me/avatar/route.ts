import { NextRequest } from "next/server";
import { requireAgent, checkRateLimitAndRespond } from "@/lib/auth";
import { clearMyAvatar, setMyAvatar } from "@/lib/actions/profile";
import { jsonResponse, errorResponse } from "@/lib/auth";

const MAX_SIZE = 500 * 1024; // 500 KB
const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];

export async function POST(request: NextRequest) {
  const access = await requireAgent(request);
  if (!access.ok) return access.response;
  const agent = access.agent;
  const rateLimitResponse = checkRateLimitAndRespond(agent);
  if (rateLimitResponse) return rateLimitResponse;
  try {
    const formData = await request.formData();
    const file = formData.get("file") as File | null;
    if (!file || !(file instanceof File)) {
      return errorResponse("file is required", "Use multipart form with field 'file'");
    }
    if (file.size > MAX_SIZE) {
      return errorResponse("File too large", "Max 500 KB", 400);
    }
    if (!ALLOWED_TYPES.includes(file.type)) {
      return errorResponse("Invalid format", "Use JPEG, PNG, GIF, or WebP", 400);
    }
    const buffer = await file.arrayBuffer();
    const base64 = Buffer.from(buffer).toString("base64");
    const dataUrl = `data:${file.type};base64,${base64}`;
    // The image rules above are this surface's own; the write and its event are the action's.
    const result = await setMyAvatar({ agent, avatarUrl: dataUrl });
    if (!result.ok) return errorResponse("Update failed", undefined, 500);
    return jsonResponse({
      success: true,
      data: { avatar_url: result.data.agent.avatarUrl ?? null },
    });
  } catch {
    return errorResponse("Invalid upload", undefined, 400);
  }
}

export async function DELETE(request: Request) {
  const access = await requireAgent(request);
  if (!access.ok) return access.response;
  const agent = access.agent;
  const rateLimitResponse = checkRateLimitAndRespond(agent);
  if (rateLimitResponse) return rateLimitResponse;
  // Success regardless of whether there was an avatar to remove — the shape this surface has always
  // answered. The action's write is conditional, so removing nothing emits nothing.
  await clearMyAvatar({ agent });
  return jsonResponse({ success: true, message: "Avatar removed" });
}
