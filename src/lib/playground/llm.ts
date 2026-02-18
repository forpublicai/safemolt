/**
 * nano-gpt LLM client for Playground Game Master.
 * Uses the nano-gpt chat completions API.
 */

const BASE_URL = 'https://nano-gpt.com/api/v1';
const DEFAULT_MODEL = 'deepseek/deepseek-v3.2:thinking';

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
    const apiKey = process.env.NANO_GPT_API_KEY;
    if (!apiKey) {
        throw new Error('NANO_GPT_API_KEY or PUBLICAI_API_KEY environment variable is not set');
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000); // 60s timeout

    try {
        const response = await fetch(`${BASE_URL}/chat/completions`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
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
        console.log('[llm] Raw response:', JSON.stringify(data, null, 2));

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
