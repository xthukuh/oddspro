import { config } from '../config.js';
import { resolveTask } from '../db/ai-rules.js';
import { isModelMissingError, aiErrorClass } from '../db/ai-guard-rules.js';
import * as openrouter from './openrouter.js';

// AI provider seam. ONE getProvider() swap point - directly mirrors
// src/sms/index.js, which already solved this shape. Adding a provider means
// implementing complete({ model, prompt, grounded }) -> { text, sources } and
// nothing else changes. (Gemini was retired permanently 2026-08-04; its
// provider module is deleted - historic fixture_ai_insights rows keep the
// 'gemini' provider string as provenance.)
const PROVIDERS = { openrouter };

// The adjudicators moved to src/ai/adjudicators.js (T9) and are no longer
// re-exported here - re-exporting them would form the import cycle the split
// exists to prevent (adjudicators -> harness -> index -> adjudicators).
// Adjudication callers import from './ai/adjudicators.js' directly.

export function getProvider(name) {
    const p = PROVIDERS[name];
    if (!p) throw new Error(`unknown ai provider: ${name}`);
    return p;
}

// Once per PROCESS per (slug, reason): a model that is down stays down for the
// whole sweep, and one line per fixture would bury the real failures under
// dozens of copies of the same one. Cleared only by a restart, which is
// exactly the granularity that matters for "is this slug still broken?".
const _loggedSlugs = new Set();
function _logOnce(key, line) {
    if (_loggedSlugs.has(key)) return;
    _loggedSlugs.add(key);
    console.warn(line);
}

// One provider call, plus the ONE bounded re-ask for an incomplete reply.
//
// openrouter.js throws with `retryable: true` when the reply was truncated at
// the ceiling or the reasoning stream consumed the budget and left no content
// (ai-parse#chatReplyOutcome). Both mean "the model had more to say than it had
// room for", so the single sane response is to ask again with more room and a
// tighter reasoning cap. Exactly one extra attempt: a second failure is a model
// that cannot answer this prompt, and the caller fails open as it always has.
async function _completeWithReask({ provider, model, prompt, grounded, json, cfg, resolve = getProvider }) {
    const p = resolve(provider);
    const opts = { model, prompt, grounded, json };
    try {
        return await p.complete({ ...opts, maxTokens: cfg.AI_MAX_TOKENS, reasoningEffort: cfg.AI_REASONING_EFFORT });
    } catch (e) {
        if (e?.retryable !== true) throw e;
        const retryTokens = cfg.AI_MAX_TOKENS_RETRY;
        _logOnce(`reask:${model}:${e.replyReason}`,
            `[ai] ${model} returned an incomplete reply (${e.replyReason}); re-asking once at max_tokens=${retryTokens}`);
        return await p.complete({
            ...opts,
            maxTokens: retryTokens,
            // 'off' means the model rejects the parameter - never send it back.
            reasoningEffort: cfg.AI_REASONING_EFFORT === 'off' ? 'off' : 'low',
        });
    }
}

// Route one enrichment task to its provider+model. Throws on failure; callers
// fail open (the pipeline never depends on the AI being up).
// `json` asks the provider for a strict JSON reply. Every structured caller in
// this codebase (adjudicators, enrichment facts/blind/anchored) parses the
// reply as JSON, so it defaults ON; `AI_JSON_MODE=0` turns it off without a
// deploy if a future model rejects the parameter.
//
// The blind task additionally carries a FALLBACK CHAIN (resolveTask ->
// ai-rules#blindCandidates). The default blind model is a single-endpoint free
// model with no internal failover, so "this slug cannot serve us right now" is
// a live condition rather than a theoretical one - it showed up in the pipeline
// log as a 404, and a retired slug shows up as a model-not-found 400.
//
// The chain advances on anything the classifier does NOT call 'permanent':
// a model-missing error, and equally a retryable one (429/5xx) that already
// exhausted the provider's own bounded backoff. Both mean the same thing by
// that point, and stopping at the first rate-limited candidate would waste a
// chain configured precisely for this - the free slugs sit behind SEPARATE
// upstream pools, so a 429 on one says nothing about the next. A 'permanent'
// error (a malformed request, bad credentials, a moderation refusal) never
// advances: re-sending it to every candidate would turn one loud, fixable bug
// into a silent multi-model failure.
//
// Blast radius stays bounded: the chain is short, and the run guard's
// consecutive-failure breaker latches long before a broad outage can be walked
// fixture by fixture.
//
// The model actually used is returned, so when a fallback answers, the caller's
// reuse tag (enrichModelTag) records THAT slug. The row therefore re-fires by
// itself on a later run once the primary is reachable again - the fallback
// banks a usable measurement without silently passing it off as the primary's.
// `deps` is the test seam (same shape as callStructured's): { getProvider }.
export async function callModel({ task, prompt, cfg = config, json = cfg.AI_JSON_MODE !== false, deps = {} }) {
    const resolve = deps.getProvider ?? getProvider;
    const { provider, model, grounded, fallbacks = [] } = resolveTask(task, cfg);
    const chain = [model, ...fallbacks];
    let lastErr;
    for (let i = 0; i < chain.length; i++) {
        const candidate = chain[i];
        try {
            const r = await _completeWithReask({ provider, model: candidate, prompt, grounded, json, cfg, resolve });
            if (i > 0) {
                _logOnce(`fallback:${candidate}`,
                    `[ai] ${task} fell back to "${candidate}" after "${model}" could not serve the call`);
            }
            return { ...r, provider, model: candidate, grounded };
        } catch (e) {
            lastErr = e;
            const last = i === chain.length - 1;
            if (aiErrorClass(e) === 'permanent' || last) throw e;
            const why = isModelMissingError(e) ? 'is unavailable' : 'kept failing';
            _logOnce(`unusable:${candidate}`,
                `[ai] model "${candidate}" ${why} (${e?.message ?? e}); trying "${chain[i + 1]}"`);
        }
    }
    throw lastErr; // unreachable: the loop returns or throws
}
