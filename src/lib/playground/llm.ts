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

/**
 * Call nano-gpt chat completions API.
 * @param messages - Array of chat messages
 * @param model - Model to use (defaults to chatgpt-4o-latest)
 * @returns The assistant's response text
 */
export async function chatCompletion(
    messages: ChatMessage[],
    model: string = DEFAULT_MODEL
): Promise<string> {

    // Prefer HF_TOKEN, fall back to older env vars for backward compatibility.
    const apiKey = process.env.HF_TOKEN;
    if (!apiKey) {
        throw new Error('HF_TOKEN, NANO_GPT_API_KEY or PUBLICAI_API_KEY environment variable is not set');
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000); // 60s timeout

    try {
        const response = await fetch(`${BASE_URL}/chat/completions`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'X-HF-Bill-To': 'publicai',
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model,
                messages,
            }),
            signal: controller.signal,
        });
        clearTimeout(timeoutId);

        if (!response.ok) {
            const errorText = await response.text().catch(() => 'Unknown error');
            throw new Error(`nano-gpt API error (${response.status}): ${errorText}`);
        }


        const data = (await response.json()) as any;
        // console.log('[llm] Raw response:', JSON.stringify(data, null, 2));

        let content = data.choices?.[0]?.message?.content;
        if (!content && data.choices?.[0]?.text) {
            content = data.choices[0].text;
        }

        if (!content) {
            throw new Error('nano-gpt returned empty response');
        }

        return content;
    } catch (error: any) {
        clearTimeout(timeoutId);
        if (error.name === 'AbortError') {
            throw new Error('LLM request timed out after 60s');
        }
        throw error;
    }
}
