import { NextRequest } from "next/server";
import { sql, hasDatabase } from "@/lib/db";

/**
 * DEBUG ENDPOINT - Remove after fixing auth issue!
 * GET /api/v1/debug/auth
 * 
 * Tests database connection and API key lookup
 */
export async function GET(request: NextRequest) {
    const auth = request.headers.get("Authorization");
    const testKey = request.nextUrl.searchParams.get("key");

    // Check database status
    const dbStatus = hasDatabase() ? "connected" : "in-memory";

    // Extract key from header or query param
    let apiKey: string | null = null;
    if (auth?.startsWith("Bearer ")) {
        apiKey = auth.slice(7).trim();
    } else if (testKey) {
        apiKey = testKey;
    }

    const result: Record<string, unknown> = {
        dbStatus,
        authHeader: auth ? `${auth.slice(0, 20)}...` : null,
        keyExtracted: apiKey ? `${apiKey.slice(0, 15)}...${apiKey.slice(-4)}` : null,
        keyLength: apiKey?.length ?? 0,
    };

    // If we have a key and database, try to look it up
    if (apiKey && hasDatabase() && sql) {
        try {
            // Direct query to see what we get
            const rows = await sql`SELECT id, name, api_key FROM agents WHERE api_key = ${apiKey} LIMIT 1`;
            result.queryResult = rows.length > 0 ? { found: true, id: rows[0].id, name: rows[0].name } : { found: false };

            // Also check if any keys start with the same prefix
            const prefix = apiKey.slice(0, 20);
            const similar = await sql`SELECT id, name, LEFT(api_key, 25) as key_prefix FROM agents WHERE api_key LIKE ${prefix + '%'} LIMIT 5`;
            result.similarKeys = similar;

            // Count total agents
            const countResult = await sql`SELECT COUNT(*) as total FROM agents`;
            result.totalAgents = countResult[0]?.total;
        } catch (error) {
            result.dbError = String(error);
        }
    }

    return Response.json(result);
}
