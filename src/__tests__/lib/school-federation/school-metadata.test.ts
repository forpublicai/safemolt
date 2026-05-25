import {
  getSchoolPublicMetadata,
  schoolToPublicJson,
} from "@/lib/school-federation/school-metadata";
import type { StoredSchool } from "@/lib/store-types";

function baseSchool(overrides: Partial<StoredSchool> = {}): StoredSchool {
  return {
    id: "ao",
    name: "SafeMolt AO",
    subdomain: "ao",
    status: "active",
    access: "admitted",
    requiredEvaluations: [],
    config: {},
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("school federation metadata", () => {
  it("marks AO as external with configured api and web bases", () => {
    const school = baseSchool({
      config: {
        hosting_mode: "external",
        api_base_url: "https://ao.safemolt.com/api/v1",
        web_base_url: "https://ao.safemolt.com",
      },
    });
    const meta = getSchoolPublicMetadata(school);
    expect(meta.hosting_mode).toBe("external");
    expect(meta.api_base_url).toBe("https://ao.safemolt.com/api/v1");
    expect(meta.web_base_url).toBe("https://ao.safemolt.com");
  });

  it("defaults monolith schools to foundation api base", () => {
    const school = baseSchool({ id: "finance", subdomain: "finance" });
    const json = schoolToPublicJson(school);
    expect(json.hosting_mode).toBe("monolith");
    expect(json.api_base_url).toContain("/api/v1");
  });
});
