/**
 * Game Master LLM client for Playground.
 * Uses Hugging Face's OpenAI-compatible router at router.huggingface.co.
 */

const BASE_URL = 'https://router.huggingface.co/v1';
const DEFAULT_MODEL = 'zai-org/GLM-5.1:fireworks-ai';

export interface ChatMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}

interface ChatCompletionResponse {
    choices: { message: { content: string } }[];
}

export type HfRouterChatOptions = {
    /** Bearer for router.huggingface.co; defaults to process.env.HF_TOKEN */
    apiKey?: string;
    model?: string;
    /**
     * When true, send X-HF-Bill-To: publicai (platform billing). Use for server HF_TOKEN only.
     * When false, omit (user BYOK). Default: true only when apiKey is omitted and HF_TOKEN is used.
     */
    billToPublicAi?: boolean;
};

/**
 * Hugging Face OpenAI-compatible router (Playground + dashboard chat).
 */
export async function chatCompletionHfRouter(
    messages: ChatMessage[],
    options?: HfRouterChatOptions
): Promise<string> {
    const envKey = process.env.HF_TOKEN?.trim();
    const apiKey = options?.apiKey?.trim() || envKey;
    if (!apiKey) {
        throw new Error('HF_TOKEN environment variable is not set');
    }

    const billToPublicAi =
        options?.billToPublicAi ??
        (!options?.apiKey?.trim() && Boolean(envKey) && apiKey === envKey);

    const model = options?.model ?? DEFAULT_MODEL;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000);

    try {
        const headers: Record<string, string> = {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
        };
        if (billToPublicAi) {
            headers['X-HF-Bill-To'] = 'publicai';
        }

        const response = await fetch(`${BASE_URL}/chat/completions`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                model,
                messages,
            }),
            signal: controller.signal,
        });
        clearTimeout(timeoutId);

        if (!response.ok) {
            const errorText = await response.text().catch(() => 'Unknown error');
            throw new Error(`HF router error (${response.status}): ${errorText}`);
        }

        const data = (await response.json()) as ChatCompletionResponse & {
            choices?: { message?: { content?: string }; text?: string }[];
        };

        let content = data.choices?.[0]?.message?.content;
        if (!content && data.choices?.[0]?.text) {
            content = data.choices[0].text;
        }

        if (!content) {
            throw new Error('HF router returned empty response');
        }

        return content;
    } catch (error: unknown) {
        clearTimeout(timeoutId);
        if (error instanceof Error && error.name === 'AbortError') {
            throw new Error('LLM request timed out after 60s');
        }
        throw error;
    }
}

/**
 * Playground GM: platform HF_TOKEN with billing header.
 */
export async function chatCompletion(
    messages: ChatMessage[],
    model: string = DEFAULT_MODEL
): Promise<string> {
    return chatCompletionHfRouter(messages, { model });
}
