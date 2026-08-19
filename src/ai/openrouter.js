import axios from 'axios';
import { config } from '../config.js';
import { withRetry } from '../db/retry-rules.js';
import { isRetryableNetworkError } from '../db/net-rules.js';

// OpenRouter provider (OpenAI-compatible chat/completions) - THE provider
// since the 2026-08-04 Gemini retirement: every AI task (adjudicate/facts/
// blind/anchored) routes here via src/db/ai-rules.js resolveTask. Transport
// only (the T9 rule): prompts/adjudication live in src/ai/adjudicators.js and
// the callStructured harness.
//
// Grounding: OpenRouter's web plugin (replaces Gemini's google_search).
// `grounded: true` attaches it with the configured engine - 'parallel'
// ($0.001/request, up to 10 results) by default; 'native' uses the model
// vendor's own search at pass-through pricing (e.g. gpt-5.6-luna
// $0.005/search). Citations come back as url_citation annotations and are
// mapped to the same { title, uri } sources shape the Gemini path produced,
// so persisted `sources` JSON stays uniform across the provider switch.
//
// Transport retries reuse the shared network retry, exactly like
// src/sms/index.js (transient ECONNRESET/TLS self-heals). A bad reply is NOT
// retried - it is a model problem, not a transport one; callers fail open.
const RETRY = { tries: 3, base: 500, isRetryable: isRetryableNetworkError };

export function enabled() {
    return Boolean(config.OPENROUTER_API_KEY);
}

export async function complete({ model, prompt, grounded = false, json = false }) {
    const body = {
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0,
    };
    // Strict JSON mode: the model must emit a syntactically valid object, so a
    // structured caller never has to mine prose for it. Live-verified on
    // openai/gpt-5.6-luna both plain and with the web plugin (2026-08-19,
    // after a run of "Expected ',' or '}' after property value" parse
    // failures that silently dropped every hot-pick verdict).
    if (json) body.response_format = { type: 'json_object' };
    if (grounded) {
        body.plugins = [{
            id: 'web',
            engine: config.AI_WEB_ENGINE,
            max_results: config.AI_WEB_MAX_RESULTS,
        }];
    }
    const res = await withRetry(() => axios.post(
        `${config.OPENROUTER_URL}/chat/completions`,
        body,
        {
            headers: {
                Authorization: `Bearer ${config.OPENROUTER_API_KEY}`,
                'Content-Type': 'application/json',
            },
            timeout: 90_000, // grounded calls run searches before answering
        },
    ), RETRY);
    const choice = res.data?.choices?.[0];
    const message = choice?.message;
    const text = message?.content;
    // A reply cut off at the token ceiling is a distinct failure from a bad
    // one: say so, instead of letting the caller report a confusing JSON
    // syntax error at whatever character the model stopped on.
    if (choice?.finish_reason === 'length') {
        throw new Error(`OpenRouter reply was truncated at the model's token limit (${text?.length ?? 0} chars)`);
    }
    if (typeof text !== 'string' || !text.trim()) {
        throw new Error('OpenRouter reply carried no message content');
    }
    // url_citation annotations -> the { title, uri } shape the callers persist.
    const sources = (Array.isArray(message?.annotations) ? message.annotations : [])
        .filter(a => a?.type === 'url_citation' && a?.url_citation?.url)
        .map(a => ({ title: a.url_citation.title ?? null, uri: a.url_citation.url }));
    return { text, sources };
}
