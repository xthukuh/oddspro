import axios from 'axios';
import { config } from '../config.js';
import { withRetry } from '../db/retry-rules.js';
import { isRetryableAiError, aiRetryAfterMs } from '../db/ai-guard-rules.js';
import { chatReplyOutcome } from '../ai-parse.js';

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
// Transport retries reuse the shared retry engine, but on the AI-specific
// predicate (src/db/ai-guard-rules.js#isRetryableAiError), NOT net-rules'
// isRetryableNetworkError. That predicate matches only faults with no HTTP
// response, so until 2026-08-23 every free-tier HTTP 429 counted as permanent:
// the live pipeline log carries 131 of them, and because each one feeds the
// run guard, five consecutive ones latched the breaker and refused the rest of
// the sweep (1091 breaker-open lines). A rate limit is the most ordinary
// transport condition there is - it must back off, not end the run.
//
// A bad REPLY is still not retried here: it is a model problem, not a
// transport one, and the one bounded re-ask with a larger budget lives in
// src/ai/index.js so this module stays transport-only (the T9 rule).
const RETRY = { tries: 4, base: 800, isRetryable: isRetryableAiError };

// A 429 usually carries the server's own "come back in N seconds". Honour it
// when present, bounded, in place of the blind exponential step.
const _sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const _retryDelay = async err => {
    const hinted = aiRetryAfterMs(err);
    if (hinted) await _sleep(hinted);
    return hinted != null;
};

export function enabled() {
    return Boolean(config.OPENROUTER_API_KEY);
}

// `maxTokens` bounds the completion; `reasoningEffort` bounds the REASONING
// stream inside it. The second is what actually fixes the empty-content class:
// every model in the current roster is a reasoning model, and with no ceiling
// declared at all the reasoning could eat the provider's default budget and
// return zero content tokens.
export async function complete({
    model, prompt, grounded = false, json = false,
    maxTokens = config.AI_MAX_TOKENS, reasoningEffort = config.AI_REASONING_EFFORT,
}) {
    const body = {
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0,
    };
    if (Number(maxTokens) > 0) body.max_tokens = Math.trunc(Number(maxTokens));
    // 'off' omits the parameter entirely, for a model that rejects it.
    if (reasoningEffort && reasoningEffort !== 'off') body.reasoning = { effort: reasoningEffort };
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
    // withRetry calls isRetryable(err) immediately before it sleeps, so the
    // predicate is the one deterministic place to capture the error the
    // upcoming sleep belongs to. That lets a 429's own Retry-After hint
    // replace the blind exponential step without changing the shared retry
    // engine's signature. Per-call closure: one in-flight request each, so
    // there is no cross-request state to race.
    let pending = null;
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
    ), {
        ...RETRY,
        isRetryable: err => { pending = err; return isRetryableAiError(err); },
        sleep: async ms => { if (!await _retryDelay(pending)) await _sleep(ms); },
    });

    // Reply shape is classified by the pure ai-parse#chatReplyOutcome, which
    // treats "truncated at the ceiling" and "reasoning burned the whole budget,
    // no content" as ONE retryable class - they were logged as two unrelated
    // errors for months while sharing a single root cause. The thrown error
    // carries `.replyReason`/`.retryable` so src/ai/index.js can decide to
    // re-ask once with a larger budget without re-parsing the message text.
    const choice = res.data?.choices?.[0];
    const outcome = chatReplyOutcome(choice);
    if (!outcome.ok) {
        throw Object.assign(new Error(outcome.message), {
            name: 'AiReplyIncomplete',
            replyReason: outcome.reason,
            retryable: outcome.retryable,
        });
    }
    // url_citation annotations -> the { title, uri } shape the callers persist.
    const sources = (Array.isArray(choice.message?.annotations) ? choice.message.annotations : [])
        .filter(a => a?.type === 'url_citation' && a?.url_citation?.url)
        .map(a => ({ title: a.url_citation.title ?? null, uri: a.url_citation.url }));
    return { text: outcome.text, sources };
}
