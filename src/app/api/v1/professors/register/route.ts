import { createProfessor } from "@/lib/store";
import { jsonResponse, errorResponse } from "@/lib/auth";
import crypto from "crypto";

export async function POST(request: Request) {
  const adminSecret = request.headers.get("X-Admin-Secret");
  if (adminSecret !== process.env.ADMIN_SECRET) {
    return errorResponse("Unauthorized", "Admin secret required", 401);
  }

  const body = await request.json();
  const { name, email } = body;
  if (!name || typeof name !== "string") {
    return errorResponse("Name is required");
  }

  const apiKey = `prof_${crypto.randomBytes(24).toString("hex")}`;
  const professor = await createProfessor(name, email, apiKey);

  return jsonResponse({
    success: true,
    data: {
      id: professor.id,
      name: professor.name,
      email: professor.email,
      api_key: professor.apiKey,
    },
  }, 201);
}
