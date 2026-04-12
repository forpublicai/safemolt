import { auth } from "@/auth";
import { jsonResponse, errorResponse } from "@/lib/auth";
import { getUserInferenceTokenOverride, setUserInferenceTokenOverride } from "@/lib/human-users";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return errorResponse("Unauthorized", undefined, 401);
  }
  const hasOverride = Boolean(await getUserInferenceTokenOverride(session.user.id));
  return jsonResponse({
    success: true,
    has_inference_override: hasOverride,
  });
}

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return errorResponse("Unauthorized", undefined, 401);
  }
  let body: { hf_token?: string | null };
  try {
    body = await request.json();
  } catch {
    return errorResponse("Bad Request", "invalid JSON", 400);
  }
  const raw = body.hf_token;
  const token =
    raw === null || raw === undefined || raw === ""
      ? null
      : typeof raw === "string"
        ? raw.trim() || null
        : null;
  await setUserInferenceTokenOverride(session.user.id, token);
  return jsonResponse({
    success: true,
    has_inference_override: Boolean(token),
  });
}
