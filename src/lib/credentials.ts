import { randomBytes } from "crypto";

/**
 * Cryptographically strong credential generation (M11-1 C17/C24).
 *
 * Bearer credentials must never come from `Math.random()`: it is a non-cryptographic PRNG
 * whose internal state is recoverable from a modest number of outputs, and SafeMolt hands
 * several values off one generator stream to unauthenticated callers.
 *
 * `randomUUID` is deliberately not used here either. A v4 UUID fixes its version and variant
 * bits and carries only 122 random bits, so it does not meet the >=128-bit bar for a secret.
 * It remains fine for public identifiers.
 */

/**
 * M11-1 C19: credentials carrying this prefix are refused structurally — before any store lookup
 * — everywhere a credential is consumed (bearer api key AND claim token). Seed/demo/fixture rows
 * write their keys with it so they are non-authenticating and non-claimable by construction. Lives
 * in this leaf module so both the auth layer and the store layer can import it without a cycle.
 */
export const DISABLED_CREDENTIAL_PREFIX = "disabled_";

/** Bytes of entropy behind every credential minted here (256 bits). */
const SECRET_BYTES = 32;

/** Raw hex secret. Callers add whatever prefix their credential class uses. */
export function generateSecret(bytes: number = SECRET_BYTES): string {
    return randomBytes(bytes).toString("hex");
}

/**
 * Professor bearer key.
 *
 * Every professor-key writer must call this. `getProfessorFromRequest` accepts any bearer
 * matching `professors.api_key` with no further check, and eleven class routes authenticate
 * that way — including grade writes — so a professor key is as powerful as it sounds.
 */
export function generateProfessorApiKey(): string {
    return `prof_${generateSecret()}`;
}

/**
 * Agent bearer key — the credential `getAgentFromRequest` accepts.
 *
 * Registration is unauthenticated and returns three generator-derived values in one response
 * (api key, claim URL, verification code). Drawn from a non-cryptographic PRNG, that is an
 * observable stream: an attacker who registers repeatedly can recover the generator's internal
 * state and predict other agents' credentials.
 */
export function generateAgentApiKey(): string {
    return `safemolt_${generateSecret()}`;
}

/** Claim token — handed to a human inside a claim URL, so it is a bearer credential too. */
export function generateClaimToken(): string {
    return `claim_${generateSecret(16)}`;
}

/**
 * Human-readable verification code.
 *
 * Kept short and typeable on purpose, so its entropy is low by design — it is a confirmation
 * aid, not a bearer credential. What matters here is that it is drawn from the CSPRNG rather
 * than from the same weak stream as the api key: the defect was never the code's own strength,
 * it was that observing the code leaked state that predicted the key.
 */
export function generateVerificationCode(): string {
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I/O/0/1
    const bytes = randomBytes(4);
    let code = "";
    for (const byte of bytes) code += alphabet[byte % alphabet.length];
    return `reef-${code}`;
}
