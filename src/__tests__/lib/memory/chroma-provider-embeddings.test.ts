/**
 * The Chroma memory provider must never let the chromadb client embed.
 *
 * chromadb 1.x defaults `getOrCreateCollection`'s embedding function to DefaultEmbeddingFunction,
 * which builds a transformers pipeline on every call and downloads the 90 MB
 * Xenova/all-MiniLM-L6-v2 model from Hugging Face (with HF_TOKEN) wherever its cache is not
 * writable — every call on Vercel. These tests drive the REAL chromadb client against a stubbed
 * HTTP layer, so the default parameter and the client's embed-on-missing-vectors paths are the
 * library's own, not a mock's.
 *
 * @jest-environment node
 */
import type { ChromaClient as ChromaClientType } from "chromadb";

type FetchCall = { url: string; method: string; body: unknown; headers: Record<string, string> };

const DIMS = 384;
const HF_URL =
  "https://router.huggingface.co/hf-inference/models/sentence-transformers/all-MiniLM-L6-v2/pipeline/feature-extraction";

const calls: FetchCall[] = [];
let hfVector: (text: string, i: number) => unknown = (_t, i) => unitVector(DIMS, i);

function unitVector(dims: number, seed: number): number[] {
  const v = Array.from({ length: dims }, (_, k) => ((k + seed) % 7) - 3);
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / norm);
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

const fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = String(input);
  const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
  calls.push({
    url,
    method: init?.method ?? "GET",
    body,
    headers: Object.fromEntries(new Headers(init?.headers).entries()),
  });
  if (url === HF_URL) {
    return json((body as { inputs: string[] }).inputs.map((t, i) => hfVector(t, i)));
  }
  if (url.endsWith("/upsert") || url.endsWith("/delete")) return json({});
  if (url.endsWith("/get")) {
    return json({ ids: [], documents: [], metadatas: [], embeddings: null, include: ["documents", "metadatas"] });
  }
  if (url.endsWith("/query")) {
    return json({
      ids: [["m1"]],
      distances: [[0.25]],
      documents: [["remembered"]],
      metadatas: [[{ kind: "note" }]],
      embeddings: null,
      include: ["documents", "metadatas", "distances"],
    });
  }
  if (url.endsWith("/collections") && init?.method === "POST") {
    return json({ id: `col-${(body as { name: string }).name}`, name: (body as { name: string }).name, metadata: null });
  }
  if (/\/databases\/[^/]+$/.test(url)) return json({ id: "db", name: "default_database", tenant: "default_tenant" });
  if (/\/tenants\/[^/]+$/.test(url)) return json({ name: "default_tenant" });
  throw new Error(`unexpected fetch ${init?.method ?? "GET"} ${url}`);
});

// chromadb captures the global fetch when it loads, so stub it before the first require.
globalThis.fetch = fetchMock as unknown as typeof fetch;
const chromadb = require("chromadb") as typeof import("chromadb");
const { createChromaVectorProvider, refuseChromaEmbedding } =
  require("@/lib/memory/providers/chroma-provider") as typeof import("@/lib/memory/providers/chroma-provider");

const ENV = { ...process.env };
let defaultGenerate: jest.SpyInstance;
let getOrCreate: jest.SpyInstance;

beforeEach(() => {
  calls.length = 0;
  hfVector = (_t, i) => unitVector(DIMS, i);
  process.env.HF_TOKEN = "hf_test_token";
  process.env.CHROMA_URL = "http://chroma.test:8000";
  delete process.env.CHROMA_TOKEN;
  delete process.env.PLAYGROUND_MOCK_EMBEDDINGS;
  defaultGenerate = jest
    .spyOn(chromadb.DefaultEmbeddingFunction.prototype, "generate")
    .mockRejectedValue(new Error("DefaultEmbeddingFunction would download a model"));
  getOrCreate = jest.spyOn(chromadb.ChromaClient.prototype, "getOrCreateCollection");
});

afterEach(() => {
  jest.restoreAllMocks();
  process.env = { ...ENV };
});

function callsTo(suffix: string): FetchCall[] {
  return calls.filter((c) => c.url.endsWith(suffix));
}

async function expectEveryCollectionRefusesToEmbed(): Promise<void> {
  expect(getOrCreate).toHaveBeenCalled();
  for (const [args] of getOrCreate.mock.calls) {
    expect(args.embeddingFunction).toBe(refuseChromaEmbedding);
  }
  for (const result of getOrCreate.mock.results) {
    const collection = await result.value;
    expect(collection.embeddingFunction).toBe(refuseChromaEmbedding);
    expect(collection.embeddingFunction).not.toBeInstanceOf(chromadb.DefaultEmbeddingFunction);
  }
}

describe("chroma provider embeddings", () => {
  it("upsert embeds text through HF Inference and sends 384-dim embeddings to Chroma", async () => {
    await createChromaVectorProvider().upsert([
      { id: "a", agentId: "agent-1", text: "first memory", metadata: { kind: "note" } },
      { id: "b", agentId: "agent-1", text: "second memory" },
    ]);

    const hf = calls.filter((c) => c.url === HF_URL);
    expect(hf).toHaveLength(1);
    expect(hf[0]!.body).toEqual({ inputs: ["first memory", "second memory"] });
    expect(hf[0]!.headers.authorization).toBe("Bearer hf_test_token");

    const [upsert] = callsTo("/upsert");
    const sent = upsert!.body as { ids: string[]; embeddings: number[][]; documents: string[] };
    expect(sent.ids).toEqual(["a", "b"]);
    expect(sent.documents).toEqual(["first memory", "second memory"]);
    expect(sent.embeddings).toHaveLength(2);
    for (const vec of sent.embeddings) expect(vec).toHaveLength(DIMS);

    expect(defaultGenerate).not.toHaveBeenCalled();
    await expectEveryCollectionRefusesToEmbed();
  });

  it("upsert keeps supplied vectors and embeds only the missing ones", async () => {
    const supplied = unitVector(DIMS, 5);
    await createChromaVectorProvider().upsert([
      { id: "a", agentId: "agent-1", text: "has vector", embedding: supplied },
      { id: "b", agentId: "agent-1", text: "needs vector" },
    ]);

    expect(calls.filter((c) => c.url === HF_URL).map((c) => c.body)).toEqual([{ inputs: ["needs vector"] }]);
    const sent = callsTo("/upsert")[0]!.body as { embeddings: number[][] };
    expect(sent.embeddings[0]).toEqual(supplied);
    expect(sent.embeddings[1]).toHaveLength(DIMS);
    expect(defaultGenerate).not.toHaveBeenCalled();
  });

  it("query embeds the query text and sends queryEmbeddings, never queryTexts", async () => {
    const out = await createChromaVectorProvider().query({ agentId: "agent-1", queryText: "what happened", limit: 3 });

    expect(calls.filter((c) => c.url === HF_URL).map((c) => c.body)).toEqual([{ inputs: ["what happened"] }]);
    const [query] = callsTo("/query");
    const sent = query!.body as Record<string, unknown>;
    expect(sent).not.toHaveProperty("query_texts");
    expect(sent.query_embeddings).toHaveLength(1);
    expect((sent.query_embeddings as number[][])[0]).toHaveLength(DIMS);
    expect(out).toEqual([{ id: "m1", text: "remembered", score: 1 / 1.25, metadata: { kind: "note" } }]);

    expect(defaultGenerate).not.toHaveBeenCalled();
    await expectEveryCollectionRefusesToEmbed();
  });

  it("read and delete paths also open collections with the refusing embedding function", async () => {
    const provider = createChromaVectorProvider();
    await provider.deleteByIdsForAgent("agent-1", ["a"]);
    await provider.getByIdsForAgent("agent-1", ["a"]);
    await provider.listAgentRecords({ agentId: "agent-1" });

    expect(getOrCreate).toHaveBeenCalledTimes(3);
    expect(callsTo("/delete")).toHaveLength(1);
    expect(callsTo("/get")).toHaveLength(2);
    await expectEveryCollectionRefusesToEmbed();
    expect(calls.some((c) => c.url === HF_URL)).toBe(false);
  });

  it("the refusing embedding function fails loudly", async () => {
    await expect(refuseChromaEmbedding.generate(["x"])).rejects.toThrow(/must not embed/);
  });

  it("rejects an HF response with the wrong dimension count before writing to Chroma", async () => {
    hfVector = () => unitVector(1024, 1);
    await expect(
      createChromaVectorProvider().upsert([{ id: "a", agentId: "agent-1", text: "x" }])
    ).rejects.toThrow(/384/);
    expect(callsTo("/upsert")).toHaveLength(0);
  });

  it("mock mode makes deterministic 384-dim unit vectors without calling Hugging Face", async () => {
    process.env.PLAYGROUND_MOCK_EMBEDDINGS = "true";
    await createChromaVectorProvider().upsert([{ id: "a", agentId: "agent-1", text: "offline" }]);

    expect(calls.some((c) => c.url === HF_URL)).toBe(false);
    const [vec] = (callsTo("/upsert")[0]!.body as { embeddings: number[][] }).embeddings;
    expect(vec).toHaveLength(DIMS);
    expect(Math.sqrt(vec!.reduce((s, x) => s + x * x, 0))).toBeCloseTo(1, 10);
  });

  // Guards the guard: without an explicit embedding function the real client falls back to
  // DefaultEmbeddingFunction, so the spy above would catch any path that regresses to it.
  it("the unpatched client path reaches DefaultEmbeddingFunction", async () => {
    const client: ChromaClientType = new chromadb.ChromaClient({ path: "http://chroma.test:8000" });
    const collection = await client.getOrCreateCollection({ name: "control" });
    expect(collection.embeddingFunction).toBeInstanceOf(chromadb.DefaultEmbeddingFunction);
    await expect(collection.upsert({ ids: ["a"], documents: ["text only"] })).rejects.toThrow(/download a model/);
    expect(defaultGenerate).toHaveBeenCalledWith(["text only"]);
  });
});
