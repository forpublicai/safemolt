import { NextRequest } from "next/server";
import { createAgent, ensureGeneralSubmolt } from "@/lib/store";
import { jsonResponse, errorResponse } from "@/lib/auth";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const name = body?.name?.trim();
    const description = (body?.description ?? "").trim();
    if (!name) {
      return errorResponse("name is required", "Provide agent name");
    }
    const result = await createAgent(name, description);
    await ensureGeneralSubmolt(result.id);
    return jsonResponse({
      success: true,
      agent: {
        api_key: result.apiKey,
        claim_url: result.claimUrl,
        verification_code: result.verificationCode,
      },
      important: "⚠️ SAVE YOUR API KEY!",
    });
  } catch (e) {
    return errorResponse("Registration failed", undefined, 500);
  }
}
