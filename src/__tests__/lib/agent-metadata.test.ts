/**
 * M11-1 C7 — profile metadata is caller-writable, and it is load-bearing for real credentials.
 *
 * That combination made it forgery rather than cosmetics: `ao_fellow` is exposed as a credential
 * through `/agents/introspect`, and `onboarding_complete` is the prerequisite the autonomy route
 * checks. The old PATCH was worse than "merges" — a metadata-only PATCH **replaced** the whole
 * object and merged only when `emoji` was also supplied, so an agent could both set platform-read
 * keys and erase existing ones.
 *
 * @jest-environment node
 */
import { readFileSync } from "fs";
import { join } from "path";
import {
    RESERVED_METADATA_KEYS,
    RESERVED_METADATA_PREFIXES,
    isReservedMetadataKey,
    validateCallerMetadata,
} from "@/lib/agent-metadata";
import { agents } from "@/lib/store/_memory-state";
import { mergeAgentMetadata } from "@/lib/store/agents/memory";
import type { StoredAgent } from "@/lib/store-types";

const REPO_ROOT = join(__dirname, "..", "..", "..");

function seed(id: string, metadata?: Record<string, unknown>): StoredAgent {
    const agent: StoredAgent = {
        id,
        name: id,
        description: "",
        apiKey: `key_${id}`,
        points: 0,
        followerCount: 0,
        isClaimed: false,
        createdAt: new Date().toISOString(),
        ...(metadata ? { metadata } : {}),
    };
    agents.set(id, agent);
    return agent;
}

beforeEach(() => agents.clear());

describe("the reserved set", () => {
    it("reserves the whole ao_* namespace by prefix, not by enumeration", () => {
        // Fellowship keys are added over time; an enumeration would rot the first time one was.
        expect(RESERVED_METADATA_PREFIXES).toContain("ao_");
        expect(isReservedMetadataKey("ao_fellow")).toBe(true);
        expect(isReservedMetadataKey("ao_fellowship_cohort")).toBe(true);
        expect(isReservedMetadataKey("ao_some_future_credential")).toBe(true);
    });

    it("reserves the named non-AO platform keys", () => {
        for (const key of RESERVED_METADATA_KEYS) {
            expect([key, isReservedMetadataKey(key)]).toEqual([key, true]);
        }
        expect(RESERVED_METADATA_KEYS).toContain("onboarding_complete");
        expect(RESERVED_METADATA_KEYS).toContain("provisioned_public_ai");
    });

    it("leaves ordinary caller keys alone", () => {
        for (const key of ["emoji", "bio", "favourite_colour", "aopolis"]) {
            expect([key, isReservedMetadataKey(key)]).toEqual([key, false]);
        }
    });
});

describe("validateCallerMetadata", () => {
    it("rejects reserved keys and names every one of them", () => {
        const result = validateCallerMetadata({ ao_fellow: true, onboarding_complete: true, bio: "hi" });
        expect(result.ok).toBe(false);
        expect(result.reserved.sort()).toEqual(["ao_fellow", "onboarding_complete"]);
    });

    it("rejects non-objects, including arrays", () => {
        for (const input of ["string", 42, null, [], undefined]) {
            expect(validateCallerMetadata(input).ok).toBe(false);
        }
    });

    it("accepts a plain object of caller-writable keys", () => {
        expect(validateCallerMetadata({ bio: "hi", emoji: "🦀" })).toEqual({ ok: true, reserved: [] });
    });
});

describe("mergeAgentMetadata", () => {
    it("merges rather than replaces, preserving keys the caller did not mention", async () => {
        seed("a1", { ao_fellow: true, emoji: "🦀" });
        await mergeAgentMetadata("a1", { bio: "new" });
        expect(agents.get("a1")?.metadata).toEqual({ ao_fellow: true, emoji: "🦀", bio: "new" });
    });

    it("creates the object when an agent has never had metadata", async () => {
        // The db side needs COALESCE for this: Postgres's `||` is strict, so a bare
        // `metadata || $delta` would yield NULL and silently erase the write it was asked to make.
        seed("a2");
        await mergeAgentMetadata("a2", { bio: "first" });
        expect(agents.get("a2")?.metadata).toEqual({ bio: "first" });
    });

    it("returns null for an unknown agent", async () => {
        expect(await mergeAgentMetadata("missing", { bio: "x" })).toBeNull();
    });
});

describe("structural: metadata cannot be written as a whole object", () => {
    it("updateAgent has no metadata parameter, in either store", () => {
        // A runtime assertion cannot do this job: a delta and a stale full copy have identical
        // types and identical runtime shapes, so no check can recover the caller's intent.
        // Removing the parameter is the only enforcement that works.
        for (const rel of ["src/lib/store/agents/db.ts", "src/lib/store/agents/memory.ts"]) {
            const source = readFileSync(join(REPO_ROOT, rel), "utf8");
            const signature = source.slice(source.indexOf("export async function updateAgent"));
            const params = signature.slice(0, signature.indexOf("{", signature.indexOf(")")));
            expect([rel, params.includes("metadata")]).toEqual([rel, false]);
        }
    });

    it("has exactly one metadata UPDATE in the db store, and it merges", () => {
        // `createAgent`'s INSERT supplies the initial object; every *update* must be the merge.
        const source = readFileSync(join(REPO_ROOT, "src/lib/store/agents/db.ts"), "utf8");
        const updates = source.split("\n").filter((line) => /SET\s+metadata/.test(line));
        expect(updates).toHaveLength(1);
        expect(updates[0]).toContain("COALESCE(metadata, '{}'::jsonb) ||");
    });

    it("the agent tool still cannot submit metadata at all", () => {
        // Expanding the tool schema to test a rejection would add surface to test a fix, which is
        // the opposite of this milestone's goal — so the assertion is on the schema itself.
        const source = readFileSync(join(REPO_ROOT, "src/lib/agent-tools/definitions/agents.ts"), "utf8");
        expect(source).not.toContain("metadata");
    });
});

describe("platform writers all use deltas", () => {
    it("no caller passes a spread of the whole metadata object into the store", () => {
        const writerFiles = [
            "src/lib/store/ao/db.ts",
            "src/app/api/dashboard/agents/[agentId]/emoji/route.ts",
            "src/app/api/dashboard/agents/[agentId]/identity/route.ts",
            "src/app/api/v1/internal/agent-metadata/route.ts",
            "src/lib/provision-public-ai-agent.ts",
            "src/app/api/v1/agents/me/route.ts",
        ];
        for (const rel of writerFiles) {
            const source = readFileSync(join(REPO_ROOT, rel), "utf8");
            expect([rel, /updateAgent\([^)]*metadata/s.test(source)]).toEqual([rel, false]);
        }
    });
});
