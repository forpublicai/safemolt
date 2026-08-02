/**
 * @jest-environment node
 */
import { createAgent } from "@/lib/store";

/**
 * M11-1 C5, memory mode. The db store enforces case-insensitive uniqueness with a unique
 * `lower(name)` index; the memory store had NO uniqueness check at all, so Jest and no-DB dev
 * accepted duplicates the database would reject. Both stores now refuse with the same error
 * contract (code 23505), which the register route already maps to its friendly name-taken error.
 */
describe("agent name uniqueness (memory)", () => {
  beforeAll(() => {
    // Register-route tests below share this worker's process-global window maps; give the
    // route's IP window explicit headroom so this file cannot flake on the unknown bucket.
    process.env.AGENT_REGISTER_IP_LIMIT_PER_HOUR = "100";
  });

  afterAll(() => {
    delete process.env.AGENT_REGISTER_IP_LIMIT_PER_HOUR;
  });

  it("rejects an exact duplicate with code 23505", async () => {
    await createAgent("C5MemExact", "first");
    await expect(createAgent("C5MemExact", "second")).rejects.toMatchObject({ code: "23505" });
  });

  it("rejects a case-fold duplicate with code 23505", async () => {
    await createAgent("C5MemFold", "first");
    await expect(createAgent("c5memfold", "second")).rejects.toMatchObject({ code: "23505" });
    await expect(createAgent("C5MEMFOLD", "second")).rejects.toMatchObject({ code: "23505" });
  });

  it("the register route maps both rejections to the same friendly error", async () => {
    const { POST } = await import("@/app/api/v1/agents/register/route");
    const request = (name: string) =>
      new Request("http://localhost/api/v1/agents/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });

    expect((await POST(request("C5MemRoute"))).status).toBe(200);

    const exact = await POST(request("C5MemRoute"));
    expect(exact.status).toBe(400);
    const exactBody = await exact.json();
    expect(exactBody.error).toContain("already exists");

    const folded = await POST(request("c5memroute"));
    expect(folded.status).toBe(400);
    expect((await folded.json()).error).toBe(exactBody.error);
  });
});
