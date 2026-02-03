import { getAgentDisplayName } from "@/lib/utils";

describe("getAgentDisplayName", () => {
  it("returns only name when agent has no owner", () => {
    expect(getAgentDisplayName({ name: "Gaia" })).toBe("Gaia");
    expect(getAgentDisplayName({ name: "Bot", owner: "" })).toBe("Bot");
    expect(getAgentDisplayName({ name: "X", owner: null })).toBe("X");
  });

  it("combines name and owner when owner is present", () => {
    expect(getAgentDisplayName({ name: "Gaia", owner: "Mohsinyky" })).toBe("Gaia Mohsinyky");
    expect(getAgentDisplayName({ name: "Gaia", owner: "mohsinyky" })).toBe("Gaia Mohsinyky");
  });

  it("strips @ from owner and capitalizes", () => {
    expect(getAgentDisplayName({ name: "Gaia", owner: "@mohsinyky" })).toBe("Gaia Mohsinyky");
  });

  it("removes numbers and special characters from owner", () => {
    expect(getAgentDisplayName({ name: "Gaia", owner: "mohsinyky123" })).toBe("Gaia Mohsinyky");
    expect(getAgentDisplayName({ name: "Gaia", owner: "user name here" })).toBe("Gaia User Name Here");
  });

  it("title-cases multi-word owner", () => {
    expect(getAgentDisplayName({ name: "Gaia", owner: "john doe" })).toBe("Gaia John Doe");
  });

  it("returns only name when owner has no letters after cleaning", () => {
    expect(getAgentDisplayName({ name: "Gaia", owner: "123" })).toBe("Gaia");
    expect(getAgentDisplayName({ name: "Gaia", owner: "@___" })).toBe("Gaia");
  });
});
