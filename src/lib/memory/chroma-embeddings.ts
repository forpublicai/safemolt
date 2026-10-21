/**
 * Vectors for the Chroma memory backend. SafeMolt computes them; the chromadb client never does.
 *
 * Left to itself, the chromadb JS client embeds on the caller's side with DefaultEmbeddingFunction,
 * which builds a fresh transformers pipeline on every call and so fetches the 90 MB
 * Xenova/all-MiniLM-L6-v2 ONNX model from Hugging Face (sending HF_TOKEN) wherever the cache is not
 * writable — every call on Vercel. The collections already hold vectors from that model, so this
 * asks HF Inference for the same one: sentence-transformers/all-MiniLM-L6-v2, mean-pooled and
 * L2-normalized, 384 dims.
 */
import { createHash } from "crypto";

export const CHROMA_EMBEDDING_MODEL = "sentence-transformers/all-MiniLM-L6-v2";
export const CHROMA_EMBEDDING_DIMS = 384;

// The model's pipeline tag is sentence-similarity, so the feature-extraction pipeline is named in the path.
const HF_FEATURE_EXTRACTION_URL = `https://router.huggingface.co/hf-inference/models/${CHROMA_EMBEDDING_MODEL}/pipeline/feature-extraction`;
/** The model reads at most 256 word pieces; this only bounds the request body. */
const MAX_EMBED_CHARS = 12000;
const MAX_BATCH = 32;

/** Throws unless `vec` is a finite vector with the collection's dimension count. */
export function assertChromaEmbedding(vec: unknown): asserts vec is number[] {
  if (
    !Array.isArray(vec) ||
    vec.length !== CHROMA_EMBEDDING_DIMS ||
    !vec.every((x) => typeof x === "number" && Number.isFinite(x))
  ) {
    const shape = Array.isArray(vec) ? `array of ${vec.length}` : typeof vec;
    throw new Error(
      `Chroma memory embedding must be ${CHROMA_EMBEDDING_DIMS} finite numbers (${CHROMA_EMBEDDING_MODEL}); got ${shape}`
    );
  }
}

function l2Normalize(vec: number[]): number[] {
  const norm = Math.sqrt(vec.reduce((s, x) => s + x * x, 0));
  return norm === 0 ? vec : vec.map((x) => x / norm);
}

/** Deterministic unit vector for PLAYGROUND_MOCK_EMBEDDINGS=true (local dev and tests). */
export function mockChromaEmbedding(text: string): number[] {
  const out: number[] = [];
  for (let block = 0; out.length < CHROMA_EMBEDDING_DIMS; block++) {
    const h = createHash("sha256").update(`${block}:${text}`, "utf8").digest();
    for (const byte of Array.from(h)) {
      if (out.length === CHROMA_EMBEDDING_DIMS) break;
      out.push((byte - 127.5) / 127.5);
    }
  }
  return l2Normalize(out);
}

async function embedBatch(texts: string[], token: string): Promise<number[][]> {
  const response = await fetch(HF_FEATURE_EXTRACTION_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "X-HF-Bill-To": "publicai",
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ inputs: texts }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Hugging Face embedding error (${response.status}) for ${CHROMA_EMBEDDING_MODEL}: ${detail.slice(0, 300)}`);
  }
  const data: unknown = await response.json();
  if (!Array.isArray(data) || data.length !== texts.length) {
    throw new Error(`Hugging Face embedding response for ${CHROMA_EMBEDDING_MODEL} is not one vector per input`);
  }
  return data.map((vec) => {
    assertChromaEmbedding(vec);
    return l2Normalize(vec);
  });
}

/** One 384-dim unit vector per text, in order. Uses the platform HF_TOKEN (billed to publicai). */
export async function embedTextsForChroma(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  if (process.env.PLAYGROUND_MOCK_EMBEDDINGS === "true") {
    return texts.map((t) => mockChromaEmbedding(t));
  }
  const token = process.env.HF_TOKEN?.trim();
  if (!token) {
    throw new Error(
      "HF_TOKEN is not set: the Chroma memory backend embeds text with Hugging Face Inference. Set PLAYGROUND_MOCK_EMBEDDINGS=true for test mode."
    );
  }
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += MAX_BATCH) {
    const batch = texts.slice(i, i + MAX_BATCH).map((t) => t.slice(0, MAX_EMBED_CHARS));
    out.push(...(await embedBatch(batch, token)));
  }
  return out;
}
