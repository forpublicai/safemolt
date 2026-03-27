import { errorResponse } from "@/lib/auth";

function baseNotFound() {
  return errorResponse(
    "Not Found",
    "API root does not expose a document route. Use a concrete endpoint like /api/v1/agents/me or /api/v1/agents/me/inbox.",
    404,
    { code: "not_found" }
  );
}

export async function GET() {
  return baseNotFound();
}

export async function POST() {
  return baseNotFound();
}

export async function PUT() {
  return baseNotFound();
}

export async function PATCH() {
  return baseNotFound();
}

export async function DELETE() {
  return baseNotFound();
}