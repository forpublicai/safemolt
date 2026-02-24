/**
 * Embedding provider for Playground Memory System.
 * Uses Chutes Qwen embedding model by default.
 * Includes mock mode for testing without API key.
 */

const CHUTES_EMBEDDING_URL = 'https://chutes-qwen-qwen3-embedding-8b.chutes.ai/v1/embeddings';
const DEFAULT_EMBEDDING_MODEL = 'Qwen/Qwen3-Embedding-8B';
const DEFAULT_EMBEDDING_DIMENSIONS = 1024; // Qwen3-Embedding-8B default

interface ChutesEmbeddingResponse {
    data: {
        embedding: number[];
        index: number;
    }[];
    model: string;
    usage: {
        prompt_tokens: number;
        total_tokens: number;
    };
}

/**
 * Get embedding vector for text using Chutes API
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

    const apiKey = process.env.EMBEDDINGS_MODELS_API_KEY;
    if (!apiKey) {
        throw new Error('EMBEDDINGS_MODELS_API_KEY environment variable is not set. Set PLAYGROUND_MOCK_EMBEDDINGS=true for test mode.');
    }

    const response = await fetch(CHUTES_EMBEDDING_URL, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            model,
            input: text,
        }),
    });

    if (!response.ok) {
        const errorText = await response.text().catch(() => 'Unknown error');
        throw new Error(`Chutes Embedding API error (${response.status}): ${errorText}`);
    }

    const data = (await response.json()) as ChutesEmbeddingResponse;
    return data.data[0]?.embedding ?? [];
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

    const apiKey = process.env.EMBEDDINGS_MODELS_API_KEY;
    if (!apiKey) {
        throw new Error('EMBEDDINGS_MODELS_API_KEY environment variable is not set. Set PLAYGROUND_MOCK_EMBEDDINGS=true for test mode.');
    }

    const response = await fetch(CHUTES_EMBEDDING_URL, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            model,
            input: texts,
        }),
    });

    if (!response.ok) {
        const errorText = await response.text().catch(() => 'Unknown error');
        throw new Error(`Chutes Embedding API error (${response.status}): ${errorText}`);
    }

    const data = (await response.json()) as ChutesEmbeddingResponse;
    // Sort by index to ensure correct order
    return data.data
        .sort((a, b) => a.index - b.index)
        .map(d => d.embedding);
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
