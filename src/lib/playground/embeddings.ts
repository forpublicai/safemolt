/**
 * Embedding provider for Playground Memory System.
 * Uses Hugging Face Inference API (feature-extraction pipeline) by default.
 * Includes mock mode for testing without API key.
 */

const HF_PIPELINE_BASE = 'https://api-inference.huggingface.co/pipeline/feature-extraction';
const DEFAULT_EMBEDDING_MODEL = 'Qwen/Qwen3-Embedding-8B';
const DEFAULT_EMBEDDING_DIMENSIONS = 1024; // Qwen3-Embedding-8B default

/**
 * Parse a single Hugging Face pipeline response into a single embedding vector.
 * Handles several response shapes and falls back to averaging token vectors.
 */
function parseHFEmbedding(resp: any): number[] {
    if (!resp) return [];

    // If response is a flat array of numbers: that's the embedding
    if (Array.isArray(resp) && resp.length > 0 && typeof resp[0] === 'number') {
        return resp as number[];
    }

    // If response is an array of token vectors: average across tokens
    if (Array.isArray(resp) && Array.isArray(resp[0]) && typeof resp[0][0] === 'number') {
        const tokenVectors = resp as number[][];
        const dims = tokenVectors[0].length;
        const sums = new Array(dims).fill(0);
        for (const vec of tokenVectors) {
            for (let i = 0; i < dims; i++) sums[i] += vec[i];
        }
        return sums.map(s => s / tokenVectors.length);
    }

    // Some APIs wrap embeddings in objects
    if (resp.embedding && Array.isArray(resp.embedding)) return resp.embedding;
    if (resp.data && Array.isArray(resp.data) && resp.data[0] && Array.isArray(resp.data[0].embedding)) return resp.data[0].embedding;
    if (resp.features && Array.isArray(resp.features) && Array.isArray(resp.features[0])) return resp.features[0] as number[];

    return [];
}

/**
 * Get embedding vector for text using Hugging Face Inference API
 * @param text - Text to embed
 * @param model - Embedding model (default: Qwen3-Embedding-8B)
 * @returns Embedding vector
 */
export async function getEmbedding(
    text: string,
    model: string = DEFAULT_EMBEDDING_MODEL
): Promise<number[]> {
    // Check for mock/test mode
    if (process.env.PLAYGROUND_MOCK_EMBEDDINGS === 'true') {
        return getMockEmbedding(text);
    }

    const apiKey = process.env.HF_TOKEN || process.env.EMBEDDINGS_MODELS_API_KEY;
    if (!apiKey) {
        throw new Error('HF_TOKEN or EMBEDDINGS_MODELS_API_KEY environment variable is not set. Set PLAYGROUND_MOCK_EMBEDDINGS=true for test mode.');
    }

    const url = `${HF_PIPELINE_BASE}/${encodeURIComponent(model)}`;

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'X-HF-Bill-To': 'publicai',
            'Content-Type': 'application/json',
            'Accept': 'application/json',
        },
        body: JSON.stringify({ inputs: text }),
    });

    if (!response.ok) {
        const errorText = await response.text().catch(() => 'Unknown error');
        throw new Error(`Hugging Face Embedding API error (${response.status}): ${errorText}`);
    }

    const data = await response.json();

    return parseHFEmbedding(data);
}

/**
 * Get multiple embeddings for an array of texts
 * @param texts - Array of texts to embed
 * @param model - Embedding model
 * @returns Array of embedding vectors
 */
export async function getEmbeddings(
    texts: string[],
    model: string = DEFAULT_EMBEDDING_MODEL
): Promise<number[][]> {
    // Check for mock/test mode
    if (process.env.PLAYGROUND_MOCK_EMBEDDINGS === 'true') {
        return texts.map(t => getMockEmbedding(t));
    }

    const apiKey = process.env.HF_TOKEN || process.env.EMBEDDINGS_MODELS_API_KEY;
    if (!apiKey) {
        throw new Error('HF_TOKEN or EMBEDDINGS_MODELS_API_KEY environment variable is not set. Set PLAYGROUND_MOCK_EMBEDDINGS=true for test mode.');
    }

    const url = `${HF_PIPELINE_BASE}/${encodeURIComponent(model)}`;

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'X-HF-Bill-To': 'publicai',
            'Content-Type': 'application/json',
            'Accept': 'application/json',
        },
        body: JSON.stringify({ inputs: texts }),
    });

    if (!response.ok) {
        const errorText = await response.text().catch(() => 'Unknown error');
        throw new Error(`Hugging Face Embedding API error (${response.status}): ${errorText}`);
    }

    const data = await response.json();

    // Expecting an array of responses (one per input)
    if (Array.isArray(data)) {
        return data.map(item => parseHFEmbedding(item));
    }

    // If API returned a single embedding (for single input), map accordingly
    const single = parseHFEmbedding(data);
    return texts.map(() => single);
}

/**
 * Generate deterministic mock embedding for testing
 * Uses simple hash-based approach for consistent results
 */
function getMockEmbedding(text: string): number[] {
    const dimensions = DEFAULT_EMBEDDING_DIMENSIONS;
    const embedding = new Array(dimensions).fill(0);
    
    // Create a deterministic seed from text
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
        const char = text.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash; // Convert to 32bit integer
    }
    
    // Use hash to seed random-like values
    const seed = Math.abs(hash);
    let state = seed;
    const nextRandom = () => {
        state = (state * 1103515245 + 12345) & 0x7fffffff;
        return state / 0x7fffffff;
    };
    
    // Generate normalized vector
    let magnitude = 0;
    for (let i = 0; i < dimensions; i++) {
        const value = nextRandom() * 2 - 1; // -1 to 1
        embedding[i] = value;
        magnitude += value * value;
    }
    
    magnitude = Math.sqrt(magnitude);
    for (let i = 0; i < dimensions; i++) {
        embedding[i] /= magnitude;
    }
    
    return embedding;
}

/**
 * Check if embedding provider is properly configured
 */
export function isEmbeddingConfigured(): boolean {
    return !!(
        process.env.EMBEDDINGS_MODELS_API_KEY || 
        process.env.PLAYGROUND_MOCK_EMBEDDINGS === 'true'
    );
}

/**
 * Get embedding model configuration
 */
export function getEmbeddingConfig(): { model: string; dimensions: number } {
    return {
        model: process.env.EMBEDDING_MODEL || DEFAULT_EMBEDDING_MODEL,
        dimensions: DEFAULT_EMBEDDING_DIMENSIONS,
    };
}
