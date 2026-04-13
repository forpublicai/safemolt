import { auth } from "@/auth";
import { jsonResponse, errorResponse } from "@/lib/auth";
import {
  getUserInferenceSettingsFlags,
  setUserInferenceSettingsFields,
} from "@/lib/human-users";
import type { InferenceSettingsUpdate } from "@/lib/human-users-inference-types";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return errorResponse("Unauthorized", undefined, 401);
  }
  const flags = await getUserInferenceSettingsFlags(session.user.id);
  return jsonResponse({
    success: true,
    ...flags,
    has_inference_override: flags.has_hf,
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

  const updates: InferenceSettingsUpdate = {};
  const tokenKeys = [
    "hf_token",
    "public_ai_token",
    "openai_token",
    "anthropic_token",
    "openrouter_token",
  ] as const;
  for (const k of tokenKeys) {
    if (Object.prototype.hasOwnProperty.call(body, k)) {
      const v = body[k];
      updates[k] = v === null || v === undefined ? null : typeof v === "string" ? v : null;
    }
  }
  if (Object.prototype.hasOwnProperty.call(body, "primary_inference_provider")) {
    const p = body.primary_inference_provider;
    updates.primary_inference_provider =
      p === null || p === undefined ? null : typeof p === "string" ? p : null;
  }

  const flags = await setUserInferenceSettingsFields(session.user.id, updates);
  return jsonResponse({
    success: true,
    ...flags,
    has_inference_override: flags.has_hf,
  });
}
