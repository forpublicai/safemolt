/**
 * @jest-environment node
 */
import { createMockVectorProvider } from "@/lib/memory/providers/mock-provider";
import { chunkTextForMemory, MIN_CHUNK_CHARS } from "@/lib/memory/chunk-text";
import { memoryDeterministicChunkId } from "@/lib/memory/memory-id";
import { normalizeMemoryMetadata } from "@/lib/memory/metadata";

describe("chunkTextForMemory", () => {
  it("returns one chunk for short text", () => {
    const s = "x".repeat(MIN_CHUNK_CHARS + 10);
    expect(chunkTextForMemory(s)).toEqual([s]);
  });

  it("splits long text into multiple chunks with overlap behavior", () => {
    const para = "word ".repeat(200).trim();
    const chunks = chunkTextForMemory(para, { chunkSize: 100, overlap: 20, minChunk: 10 });
    expect(chunks.length).toBeGreaterThan(1);
    chunks.forEach((c) => expect(c.length).toBeGreaterThanOrEqual(10));
  });
});

describe("memoryDeterministicChunkId", () => {
  it("is stable for same inputs", () => {
    const a = memoryDeterministicChunkId("ag1", "parent", 3);
    const b = memoryDeterministicChunkId("ag1", "parent", 3);
    expect(a).toBe(b);
    expect(a.startsWith("sm_")).toBe(true);
  });

  it("differs by chunk index", () => {
    expect(memoryDeterministicChunkId("ag1", "parent", 0)).not.toBe(
      memoryDeterministicChunkId("ag1", "parent", 1)
    );
  });
});

describe("normalizeMemoryMetadata", () => {
  it("sets defaults and clamps importance", () => {
    const m = normalizeMemoryMetadata(
      { kind: "note", importance: 9999999, summary: "hi" },
      { source: "api" }
    );
    expect(m.kind).toBe("note");
    expect(m.source).toBe("api");
    expect(m.importance).toBe(1_000_000);
    expect(m.summary).toBe("hi");
    expect(typeof m.filed_at).toBe("string");
  });
});

describe("mock VectorMemoryProvider delete scoping", () => {
  it("only deletes vectors for the given agent", async () => {
    const p = createMockVectorProvider();
    const emb = [1, 0, 0];
    await p.upsert([
      { id: "a1", agentId: "agent-a", text: "t1", embedding: emb, metadata: {} },
      { id: "b1", agentId: "agent-b", text: "t2", embedding: emb, metadata: {} },
    ]);
    await p.deleteByIdsForAgent("agent-a", ["a1", "b1"]);
    const left = await p.query({ agentId: "agent-b", queryEmbedding: emb, limit: 10 });
    expect(left.some((r) => r.id === "b1")).toBe(true);
    const gone = await p.query({ agentId: "agent-a", queryEmbedding: emb, limit: 10 });
    expect(gone.some((r) => r.id === "a1")).toBe(false);
  });
});

describe("mock VectorMemoryProvider getByIdsForAgent", () => {
  it("returns only matching agent ids", async () => {
    const p = createMockVectorProvider();
    const emb = [0, 1, 0];
    await p.upsert([{ id: "x", agentId: "a1", text: "hello", embedding: emb }]);
    const got = await p.getByIdsForAgent("a1", ["x"]);
    expect(got).toHaveLength(1);
    expect(got[0]!.text).toBe("hello");
    const empty = await p.getByIdsForAgent("other", ["x"]);
    expect(empty).toHaveLength(0);
  });
});
