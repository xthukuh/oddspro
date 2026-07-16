import axios from 'axios';
import { config } from '../config.js';
import { withRetry } from '../db/retry-rules.js';
import { isRetryableNetworkError } from '../db/net-rules.js';

// OpenRouter provider (OpenAI-compatible chat/completions). Used for the BLIND
// reasoner only, and pinned to a NON-Google model: two Google models agreeing
// is Gemini agreeing with itself, so reasoner independence is a correctness
// requirement of the experiment, not a preference.
//
// No grounding: OpenRouter has no google_search equivalent here, and the blind
// call deliberately works only the facts the grounded pass already extracted -
// which is what makes blind-vs-anchored a fair paired comparison.
//
// Transport retries reuse the shared network retry, exactly like src/sms/index.js
// (transient ECONNRESET/TLS self-heals). A bad reply is NOT retried - it is a
// model problem, not a transport one, and the caller fails open.
const RETRY = { tries: 3, base: 500, isRetryable: isRetryableNetworkError };

export function enabled() {
    return Boolean(config.OPENROUTER_API_KEY);
}

export async function complete({ model, prompt }) {
    const res = await withRetry(() => axios.post(
        `${config.OPENROUTER_URL}/chat/completions`,
        { model, messages: [{ role: 'user', content: prompt }], temperature: 0 },
        {
            headers: {
                Authorization: `Bearer ${config.OPENROUTER_API_KEY}`,
                'Content-Type': 'application/json',
            },
            timeout: 60_000,
        },
    ), RETRY);
    const text = res.data?.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || !text.trim()) {
        throw new Error('OpenRouter reply carried no message content');
    }
    return { text, sources: [] };
}
