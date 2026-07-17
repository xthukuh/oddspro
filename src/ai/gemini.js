import axios from 'axios';
import { config } from '../config.js';
import { extractGeminiText } from '../ai-parse.js';
import { withRetry } from '../db/retry-rules.js';
import { isRetryableNetworkError } from '../db/net-rules.js';

// Google Gemini provider - TRANSPORT ONLY since T9 (Detour B): the hot-pick/
// tip adjudicators and their prompts live in src/ai/adjudicators.js and ride
// the callStructured harness (src/ai/harness.js); this module owns nothing
// but the HTTP round-trip. Adding provider behavior here would re-grow the
// import cycle the split removed (harness -> index -> gemini).

export function aiEnabled() {
    return Boolean(config.GEMINI_API_KEY);
}

// Alias matching the provider-seam interface openrouter.js already exposes
// (M4.1 final review finding 4: `openrouter.enabled()` had zero callers -
// dead code, and there was no symmetric Gemini check a caller COULD route
// through). src/enrich.js's preflight calls getProvider(name).enabled() for
// BOTH providers uniformly instead of reaching into each module's own
// differently-named check; aiEnabled() itself stays as the name every
// existing adjudication call site already expects.
export const enabled = aiEnabled;

// Generic single completion. Returns raw text + grounding citations; the
// caller applies its own per-kind zod schema (via the harness). Throws on
// any failure - callers fail open. Transient transport errors self-heal via
// withRetry; a bad reply is a model problem and is never retried
// (isRetryableNetworkError excludes anything with a response).
const RETRY = { tries: 3, base: 500, isRetryable: isRetryableNetworkError };

export async function complete({ model, prompt, grounded }) {
    const res = await withRetry(() => axios.post(
        `${config.GEMINI_URL}/models/${model}:generateContent`,
        {
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0 },
            ...(grounded ? { tools: [{ google_search: {} }] } : {}),
        },
        {
            headers: { 'x-goog-api-key': config.GEMINI_API_KEY, 'Content-Type': 'application/json' },
            timeout: 60_000, // grounded calls run searches before answering
        },
    ), RETRY);
    return extractGeminiText(res.data);
}
