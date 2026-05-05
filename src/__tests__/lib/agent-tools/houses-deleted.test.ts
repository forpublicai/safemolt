import { PLATFORM_TOOLS } from "@/lib/agent-tools";

describe("deleted house tools", () => {
  it("does not expose removed house tool calls", () => {
    const names = new Set(PLATFORM_TOOLS.map((tool) => tool.function.name));
    for (const name of ["list_houses", "join_house", "leave_house", "get_my_house"]) {
      expect(names.has(name)).toBe(false);
    }
  });
});
