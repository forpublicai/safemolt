/**
 * Reserved agent-metadata keys (M11-1 C7).
 *
 * `agents.metadata` is not decoration — it is load-bearing for real credentials, which is what
 * turns a caller-writable blob into forgery rather than cosmetics:
 *
 *   - `ao_fellow` / `ao_fellowship_cohort` are written by the platform and **exposed as
 *     credentials** through `/api/v1/agents/introspect`;
 *   - `onboarding_complete` is written during provisioning and **authorizes enabling autonomy**
 *     (`dashboard/agents/{agentId}/autonomy`).
 *
 * Stated precisely, because the imprecise version would not survive review: the autonomy route
 * additionally requires a Cognito session and an ownership check, so forging
 * `onboarding_complete` is *prerequisite* forgery on an owned agent, not a one-PATCH autonomy
 * grant. `ao_fellow` has no such second gate.
 *
 * One exported constant, imported by every platform surface, so adding a platform key cannot
 * forget the reservation. The `ao_*` rule is a **prefix**, since fellowship keys are added over
 * time and an enumeration would rot the first time one was.
 */

/**
 * The AO namespace. Exported by name because two different rules key on it — the caller-facing
 * reservation here, and the federation writer's allowlist in
 * `api/v1/internal/agent-metadata` — and two hand-written copies of `"ao_"` would drift.
 */
export const AO_METADATA_PREFIX = "ao_";

/** Whole namespaces reserved by prefix. */
export const RESERVED_METADATA_PREFIXES = [AO_METADATA_PREFIX] as const;

/** Individually reserved keys outside a reserved namespace. */
export const RESERVED_METADATA_KEYS = [
    "system",
    "test",
    "source",
    "provisioned_public_ai",
    "onboarding_complete",
    "public_ai_handle_style",
] as const;

export function isReservedMetadataKey(key: string): boolean {
    return (
        RESERVED_METADATA_PREFIXES.some((prefix) => key.startsWith(prefix)) ||
        (RESERVED_METADATA_KEYS as readonly string[]).includes(key)
    );
}

export interface MetadataValidationResult {
    ok: boolean;
    /** Reserved keys the caller tried to write, in input order. */
    reserved: string[];
}

/**
 * Validate caller-supplied metadata.
 *
 * Reserved keys are **rejected**, not silently stripped — one behaviour, stated once. Silent
 * stripping would let an agent believe it had set a credential and leave the platform's own value
 * in place, which is a worse contract than a stable error naming the key.
 */
export function validateCallerMetadata(input: unknown): MetadataValidationResult {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
        return { ok: false, reserved: [] };
    }
    const reserved = Object.keys(input as Record<string, unknown>).filter(isReservedMetadataKey);
    return { ok: reserved.length === 0, reserved };
}
