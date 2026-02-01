import { NextRequest } from "next/server";
import { getAgentFromRequest } from "@/lib/auth";
import { setAgentAvatar, clearAgentAvatar } from "@/lib/store";
import { jsonResponse, errorResponse } from "@/lib/auth";

const MAX_SIZE = 500 * 1024; // 500 KB
const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];

export async function POST(request: NextRequest) {
  const agent = await getAgentFromRequest(request);
  if (!agent) {
    return errorResponse("Unauthorized", "Valid Authorization: Bearer <api_key> required", 401);
  }
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
    const updated = await setAgentAvatar(agent.id, dataUrl);
    if (!updated) return errorResponse("Update failed", undefined, 500);
    return jsonResponse({
      success: true,
      data: { avatar_url: updated.avatarUrl ?? null },
    });
  } catch {
    return errorResponse("Invalid upload", undefined, 400);
  }
}

export async function DELETE(request: Request) {
  const agent = await getAgentFromRequest(request);
  if (!agent) {
    return errorResponse("Unauthorized", "Valid Authorization: Bearer <api_key> required", 401);
  }
  await clearAgentAvatar(agent.id);
  return jsonResponse({ success: true, message: "Avatar removed" });
}
