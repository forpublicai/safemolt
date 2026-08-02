/**
 * The headers `src/middleware.ts` stamps onto every request before a handler sees it.
 *
 * Route tests construct `Request`/`NextRequest` objects directly, which skips middleware — so a
 * hand-built request is *not* the shape production delivers. That difference used to be invisible,
 * because `platformAccessDenial` fell back to recomputing the school from the `Host` header when
 * `x-school-id` was absent. M11-1 removed that fallback: `Host` is caller-controlled, and
 * `extractSchoolFromHost` answers `foundation` — the weaker of the two access rules — for every
 * hostname it does not recognise, so the fallback made raw request input the security boundary in
 * exactly the situation where the trusted path had failed. The rule now fails closed.
 *
 * Tests therefore have to supply what middleware supplies. Using this helper keeps that honest: it
 * simulates middleware rather than relaxing the gate, and the school defaults to `foundation`
 * because that is what `extractSchoolFromHost` returns for `localhost` and the bare domain.
 */
export const MIDDLEWARE_SCHOOL_HEADER = "x-school-id";

export function middlewareHeaders(schoolId = "foundation"): Record<string, string> {
    return { [MIDDLEWARE_SCHOOL_HEADER]: schoolId };
}

/**
 * Merge the middleware headers into a `RequestInit`, preserving anything the caller already set —
 * including an explicit `x-school-id`, so a test that pins a non-Foundation school still wins.
 */
export function withMiddlewareHeaders(init: RequestInit = {}, schoolId = "foundation"): RequestInit {
    const headers = new Headers(init.headers as HeadersInit | undefined);
    if (!headers.has(MIDDLEWARE_SCHOOL_HEADER)) headers.set(MIDDLEWARE_SCHOOL_HEADER, schoolId);
    return { ...init, headers: Object.fromEntries(headers.entries()) };
}
