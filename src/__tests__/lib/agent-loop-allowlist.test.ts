import { LOOP_TOOL_NAMES } from "@/lib/agent-runtime";

describe("autonomous loop tool allowlist", () => {
  it("allows create_comment so duplicate news can route to existing discussions", () => {
    expect(LOOP_TOOL_NAMES.has("create_comment")).toBe(true);
  });
});
