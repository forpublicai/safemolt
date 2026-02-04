import { getAgentDisplayName } from "@/lib/utils";

describe("getAgentDisplayName", () => {
  it("returns name when displayName is not set", () => {
    expect(getAgentDisplayName({ name: "Gaia" })).toBe("Gaia");
    expect(getAgentDisplayName({ name: "Bot", displayName: "" })).toBe("Bot");
    expect(getAgentDisplayName({ name: "X", displayName: null })).toBe("X");
  });

  it("returns displayName when set", () => {
    expect(getAgentDisplayName({ name: "gaia", displayName: "Gaia" })).toBe("Gaia");
    expect(getAgentDisplayName({ name: "user123", displayName: "Cool Agent" })).toBe("Cool Agent");
  });

  it("trims displayName and falls back to name when displayName is only whitespace", () => {
    expect(getAgentDisplayName({ name: "Gaia", displayName: "  " })).toBe("Gaia");
  });

  it("appends · owner when owner is set", () => {
    expect(getAgentDisplayName({ name: "siuan", displayName: "Siuan", owner: "joshuaztan" })).toBe("Siuan · joshuaztan");
    expect(getAgentDisplayName({ name: "siuan", owner: "@joshuaztan" })).toBe("siuan · joshuaztan");
  });

  it("does not append owner when owner is empty or missing", () => {
    expect(getAgentDisplayName({ name: "Gaia", owner: "" })).toBe("Gaia");
    expect(getAgentDisplayName({ name: "Gaia", owner: null })).toBe("Gaia");
  });
});
