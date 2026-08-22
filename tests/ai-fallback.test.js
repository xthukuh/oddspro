// The AI provider seam's two resilience behaviours (src/ai/index.js,
// 2026-08-23): the blind fallback chain and the single re-ask after an
// incomplete reply. Offline - the provider is injected via `deps.getProvider`,
// exactly like callStructured's own test seam, so no HTTP client is reached.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callModel } from '../src/ai/index.js';

const CFG = {
    HOTPICK_AI_MODEL: 'openai/gpt-5.6-luna',
    OPENROUTER_MODEL: 'nvidia/primary',
    AI_ANCHORED_MODEL: 'deepseek/anchored',
    AI_FACTS_MODEL: 'deepseek/anchored',
    AI_BLIND_MODEL: '',
    AI_BLIND_MODEL_FALLBACKS: 'z-ai/second,cohere/third',
    AI_MAX_TOKENS: 3000,
    AI_MAX_TOKENS_RETRY: 8000,
    AI_REASONING_EFFORT: 'low',
    HOTPICK_AI_WEB: 0,
};

const httpErr = status => Object.assign(new Error(`Request failed with status code ${status}`), {
    isAxiosError: true, response: { status, headers: {} },
});
const incomplete = reason => Object.assign(new Error(`incomplete: ${reason}`), {
    name: 'AiReplyIncomplete', replyReason: reason, retryable: true,
});

// A provider stub recording every complete() call; `script` maps the model slug
// to either an Error to throw or a reply to return. A function value is called
// with the attempt count for that slug, so a test can fail once then succeed.
const stubProvider = script => {
    const calls = [];
    return {
        calls,
        provider: {
            enabled: () => true,
            complete: async opts => {
                calls.push(opts);
                const seen = calls.filter(c => c.model === opts.model).length;
                const entry = script[opts.model];
                const value = typeof entry === 'function' ? entry(seen) : entry;
                if (value instanceof Error) throw value;
                return value ?? { text: `{"from":"${opts.model}"}`, sources: [] };
            },
        },
    };
};

// --- the blind fallback chain ------------------------------------------------

test('callModel advances to the next blind model on a 404', () => {
    const s = stubProvider({ 'nvidia/primary': httpErr(404) });
    return callModel({ task: 'blind', prompt: 'p', cfg: CFG, deps: { getProvider: () => s.provider } })
        .then(r => {
            assert.equal(r.model, 'z-ai/second');
            assert.deepEqual(s.calls.map(c => c.model), ['nvidia/primary', 'z-ai/second']);
            // The RETURNED model is the one that actually answered, so the
            // caller's reuse tag records the fallback rather than passing its
            // answer off as the primary's.
            assert.equal(r.text, '{"from":"z-ai/second"}');
        });
});

test('callModel walks the whole chain and throws the last error when every slug 404s', async () => {
    const s = stubProvider({
        'nvidia/primary': httpErr(404), 'z-ai/second': httpErr(404), 'cohere/third': httpErr(404),
    });
    await assert.rejects(
        () => callModel({ task: 'blind', prompt: 'p', cfg: CFG, deps: { getProvider: () => s.provider } }),
        /404/,
    );
    assert.deepEqual(s.calls.map(c => c.model), ['nvidia/primary', 'z-ai/second', 'cohere/third']);
});

test('callModel advances the chain for a RETIRED slug, which arrives as a 400', async () => {
    // The live shape: OpenRouter answers an unknown/retired slug with 400
    // "<slug> is not a valid model ID". This is the case the brief predicted
    // ("if a slug is gone, that is the 404") - it just is not a 404.
    const err = Object.assign(new Error('Request failed with status code 400'), {
        isAxiosError: true,
        response: { status: 400, headers: {}, data: { error: { message: 'nvidia/primary is not a valid model ID' } } },
    });
    const s = stubProvider({ 'nvidia/primary': err });
    const r = await callModel({ task: 'blind', prompt: 'p', cfg: CFG, deps: { getProvider: () => s.provider } });
    assert.equal(r.model, 'z-ai/second');
});

test('callModel does NOT advance the chain on an ordinary 400', async () => {
    const err = Object.assign(new Error('Request failed with status code 400'), {
        isAxiosError: true,
        response: { status: 400, headers: {}, data: { error: { message: 'temperature must be a number' } } },
    });
    const s = stubProvider({ 'nvidia/primary': err });
    await assert.rejects(
        () => callModel({ task: 'blind', prompt: 'p', cfg: CFG, deps: { getProvider: () => s.provider } }),
        /400/,
    );
    assert.deepEqual(s.calls.map(c => c.model), ['nvidia/primary']);
});

test('callModel advances the chain when a candidate has exhausted its own backoff', async () => {
    // The provider has ALREADY spent its bounded retries by the time this
    // error surfaces, so a 429/5xx here means that candidate cannot serve the
    // call now. Live-verified 2026-08-23: a dead primary fell through to
    // z-ai/glm-5.2:free, which was itself rate-limited - stopping there would
    // have wasted a chain configured for exactly this, since the free slugs
    // sit behind separate upstream pools.
    for (const status of [429, 500, 503]) {
        const s = stubProvider({ 'nvidia/primary': httpErr(status) });
        const r = await callModel({ task: 'blind', prompt: 'p', cfg: CFG, deps: { getProvider: () => s.provider } });
        assert.equal(r.model, 'z-ai/second', `status ${status} must fall through`);
    }
});

test('callModel throws the last error once the whole chain is exhausted by rate limits', async () => {
    const s = stubProvider({
        'nvidia/primary': httpErr(429), 'z-ai/second': httpErr(429), 'cohere/third': httpErr(429),
    });
    await assert.rejects(
        () => callModel({ task: 'blind', prompt: 'p', cfg: CFG, deps: { getProvider: () => s.provider } }),
        /429/,
    );
    assert.equal(s.calls.length, 3);
});

test('a task with no chain (anchored) never falls back, even on a 404', async () => {
    const s = stubProvider({ 'deepseek/anchored': httpErr(404) });
    await assert.rejects(
        () => callModel({ task: 'anchored', prompt: 'p', cfg: CFG, deps: { getProvider: () => s.provider } }),
        /404/,
    );
    assert.deepEqual(s.calls.map(c => c.model), ['deepseek/anchored']);
});

// --- the bounded re-ask ------------------------------------------------------

test('callModel re-asks ONCE with a raised ceiling after an incomplete reply', async () => {
    const s = stubProvider({
        'deepseek/anchored': n => (n === 1 ? incomplete('reasoning-only') : { text: '{"ok":1}', sources: [] }),
    });
    const r = await callModel({ task: 'anchored', prompt: 'p', cfg: CFG, deps: { getProvider: () => s.provider } });
    assert.equal(r.text, '{"ok":1}');
    assert.equal(s.calls.length, 2);
    assert.equal(s.calls[0].maxTokens, 3000, 'first attempt uses the normal ceiling');
    assert.equal(s.calls[1].maxTokens, 8000, 'the re-ask raises it');
    assert.equal(s.calls[1].reasoningEffort, 'low', 'and caps reasoning so content is reached');
});

test('the re-ask happens at most once - a second incomplete reply fails open', async () => {
    const s = stubProvider({ 'deepseek/anchored': incomplete('truncated') });
    await assert.rejects(
        () => callModel({ task: 'anchored', prompt: 'p', cfg: CFG, deps: { getProvider: () => s.provider } }),
        /incomplete/,
    );
    assert.equal(s.calls.length, 2, 'exactly one extra attempt, never a loop');
});

test('a non-retryable failure is never re-asked', async () => {
    const s = stubProvider({ 'deepseek/anchored': httpErr(400) });
    await assert.rejects(
        () => callModel({ task: 'anchored', prompt: 'p', cfg: CFG, deps: { getProvider: () => s.provider } }),
        /400/,
    );
    assert.equal(s.calls.length, 1);
});

test('AI_REASONING_EFFORT=off is preserved through the re-ask', async () => {
    // 'off' means the model REJECTS the parameter; sending it on the retry
    // would turn a recoverable truncation into a hard 400.
    const cfg = { ...CFG, AI_REASONING_EFFORT: 'off' };
    const s = stubProvider({
        'deepseek/anchored': n => (n === 1 ? incomplete('truncated') : { text: '{}', sources: [] }),
    });
    await callModel({ task: 'anchored', prompt: 'p', cfg, deps: { getProvider: () => s.provider } });
    assert.equal(s.calls[1].reasoningEffort, 'off');
});

test('the token ceiling and reasoning cap ride every first attempt', async () => {
    const s = stubProvider({});
    await callModel({ task: 'blind', prompt: 'p', cfg: CFG, deps: { getProvider: () => s.provider } });
    assert.equal(s.calls[0].maxTokens, 3000);
    assert.equal(s.calls[0].reasoningEffort, 'low');
    // Sending NO ceiling at all was the truncation bug: a reasoning model could
    // spend the provider's default budget thinking and emit zero content.
    assert.notEqual(s.calls[0].maxTokens, undefined);
});

test('json mode follows AI_JSON_MODE (the knob was declared but never wired until 2026-08-23)', async () => {
    const s = stubProvider({});
    await callModel({ task: 'blind', prompt: 'p', cfg: { ...CFG, AI_JSON_MODE: false }, deps: { getProvider: () => s.provider } });
    assert.equal(s.calls[0].json, false);

    const on = stubProvider({});
    await callModel({ task: 'blind', prompt: 'p', cfg: { ...CFG, AI_JSON_MODE: true }, deps: { getProvider: () => on.provider } });
    assert.equal(on.calls[0].json, true);
});
