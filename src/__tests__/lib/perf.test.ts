import { serverTimingHeader } from "@/lib/perf";

describe("perf helpers", () => {
  it("formats Server-Timing fragments", () => {
    expect(serverTimingHeader([{ name: "x", ms: 12.34 }])).toBe("x;dur=12.3");
  });
});
