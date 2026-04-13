import { auth } from "@/auth";
import { jsonResponse, errorResponse } from "@/lib/auth";
import { getSponsoredInferenceUsageToday } from "@/lib/human-users";

function dailyLimit(): number {
  return parseInt(
    process.env.PUBLIC_AI_SPONSORED_DAILY_LIMIT || process.env.DEMO_DAILY_REQUEST_LIMIT || "100",
    10
  );
}

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return errorResponse("Unauthorized", undefined, 401);
  }
  const limit = dailyLimit();
  const used = await getSponsoredInferenceUsageToday(session.user.id);
  return jsonResponse({
    success: true,
    limit,
    used,
    remaining: Math.max(0, limit - used),
  });
}
