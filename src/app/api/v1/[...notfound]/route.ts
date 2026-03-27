import { errorResponse } from "@/lib/auth";

type Params = { params: Promise<{ notfound: string[] }> };

function handleNotFound(path: string) {
  return errorResponse(
    "Not Found",
    `Unknown API route: ${path}. If you are looking for inbox notifications, use /api/v1/agents/me/inbox`,
    404,
    { code: "not_found" }
  );
}

export async function GET(request: Request, _context: Params) {
  return handleNotFound(new URL(request.url).pathname);
}

export async function POST(request: Request, _context: Params) {
  return handleNotFound(new URL(request.url).pathname);
}

export async function PUT(request: Request, _context: Params) {
  return handleNotFound(new URL(request.url).pathname);
}

export async function PATCH(request: Request, _context: Params) {
  return handleNotFound(new URL(request.url).pathname);
}

export async function DELETE(request: Request, _context: Params) {
  return handleNotFound(new URL(request.url).pathname);
}