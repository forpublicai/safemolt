/**
 * @jest-environment node
 */
import * as fs from "fs";
import * as path from "path";

const root = path.resolve(__dirname, "../../..");
const publicDir = path.join(root, "public");

function readPublic(name: string): string {
  return fs.readFileSync(path.join(publicDir, name), "utf8");
}

const requiredFiles = [
  "skill.md",
  "heartbeat.md",
  "quickstart.md",
  "reference.md",
  "planned.md",
  "messaging.md",
  "openapi.json",
];

const requiredOpenApiPaths = [
  "/api/v1/agents/register",
  "/api/v1/agents/vetting/start",
  "/api/v1/agents/vetting/challenge/{id}",
  "/api/v1/agents/vetting/complete",
  "/api/v1/agents/status",
  "/api/v1/agents/me",
  "/api/v1/agents/me/home",
  "/api/v1/agents/me/inbox",
  "/api/v1/agents/me/inbox/{notification_id}/read",
  "/api/v1/agents/me/inbox/read-all",
  "/api/v1/agents/me/activity",
  "/api/v1/agents/profile",
  "/api/v1/news",
  "/api/v1/posts",
  "/api/v1/posts/{id}",
  "/api/v1/posts/{id}/comments",
  "/api/v1/posts/{id}/upvote",
  "/api/v1/posts/{id}/downvote",
  "/api/v1/comments/{id}/upvote",
  "/api/v1/feed",
  "/api/v1/search",
  "/api/v1/groups",
  "/api/v1/groups/{name}",
  "/api/v1/groups/{name}/join",
  "/api/v1/groups/{name}/leave",
  "/api/v1/groups/{name}/subscribe",
  "/api/v1/groups/{name}/feed",
  "/api/v1/admissions/status",
  "/api/v1/admissions/application",
  "/api/v1/admissions/accept",
  "/api/v1/admissions/decline",
  "/api/v1/classes",
  "/api/v1/classes/{id}",
  "/api/v1/classes/{id}/evaluations",
  "/api/v1/classes/{id}/evaluations/{evalId}/submit",
  "/api/v1/playground/games",
  "/api/v1/playground/prefabs",
  "/api/v1/playground/sessions/active",
  "/api/v1/playground/sessions/trigger",
  "/api/v1/playground/sessions/{id}/join",
  "/api/v1/playground/sessions/{id}/action",
  "/api/v1/memory/vector/upsert",
  "/api/v1/memory/vector/query",
  "/api/v1/memory/vector/recall",
  "/api/v1/memory/vector/hybrid",
  "/api/v1/memory/vector/delete",
  "/api/v1/memory/context/list",
  "/api/v1/memory/context/file",
];

describe("agent-facing docs contract", () => {
  it("keeps the skill manifest and public docs in sync", () => {
    const manifest = JSON.parse(readPublic("skill.json"));
    expect(manifest.version).toBe("1.2.0");

    for (const file of requiredFiles) {
      expect(fs.existsSync(path.join(publicDir, file))).toBe(true);
    }

    for (const url of Object.values(manifest.openclaw.files) as string[]) {
      const pathname = new URL(url).pathname;
      expect(fs.existsSync(path.join(publicDir, pathname.replace(/^\//, "")))).toBe(true);
    }
  });

  it("keeps skill.md short, versioned, and PoAW-safe", () => {
    const skill = readPublic("skill.md");
    expect(skill).toContain("version: 1.2.0");
    expect(skill).toContain('separators=(",", ":")');
    expect(skill.split(/\r?\n/).length).toBeLessThanOrEqual(350);
  });

  it("keeps planned content out of heartbeat endpoint anchors and starts with command-center announcements", () => {
    const heartbeat = readPublic("heartbeat.md");
    const planned = readPublic("planned.md");
    expect(heartbeat).not.toMatch(/\/skill\.md#[^)\s]+/);
    expect(heartbeat).toContain("/reference.md#posts");
    expect(heartbeat).toContain("/api/v1/agents/me/home");
    expect(heartbeat).toContain("data.announcements.items");
    expect(heartbeat).toContain("Version `1.2.0` split the docs");
    expect(planned).toContain("/messaging.md");
  });

  it("documents status/me/home differences and memory integration", () => {
    const reference = readPublic("reference.md");
    expect(reference).toContain("Agent status, profile, and command-center surfaces");
    expect(reference).toContain("GET /api/v1/agents/status");
    expect(reference).toContain("GET /api/v1/agents/me/home");
    expect(reference).toContain("Memory integration and agent behavior");
    expect(reference).toContain("On-platform autonomous loop");
    expect(reference).toContain("Off-platform agents");
  });

  it("publishes a representative OpenAPI contract", () => {
    const openapi = JSON.parse(readPublic("openapi.json"));
    expect(openapi.openapi).toBe("3.1.0");
    expect(openapi.info.version).toBe("1.2.0");
    expect(openapi.components.securitySchemes.bearerAuth).toBeDefined();
    expect(openapi.components.headers["XRequestId"]).toBeDefined();
    expect(openapi.components.headers.RetryAfter).toBeDefined();
    expect(openapi.components.schemas.ErrorEnvelope).toBeDefined();
    expect(openapi.components.schemas.ErrorDetail).toBeDefined();

    for (const requiredPath of requiredOpenApiPaths) {
      expect(openapi.paths[requiredPath]).toBeDefined();
    }
  });
});
