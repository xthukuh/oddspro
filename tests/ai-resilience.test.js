// AI transport resilience (2026-08-23): the pure decision core behind the
// three enrichment failure classes read off the live pipeline log.
//
// Evidence (logs/pipeline.log, 2026-08-19 .. 2026-08-22):
//   1091 x "AI run guard open: breaker-open"   <- the cascade, not a cause
//    131 x "Request failed with status code 429"
//     30 x "OpenRouter reply carried no message content"
//      4 x "OpenRouter reply was truncated at the model's token limit (0 chars)"
//      1 x "Request failed with status code 404"   (blind task)
//
// Everything asserted here is pure and offline - no network, no .env, no DB.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { aiErrorClass, isRetryableAiError, isModelMissingError, aiRetryAfterMs } from '../src/db/ai-guard-rules.js';
import { chatReplyOutcome } from '../src/ai-parse.js';
import {
    parseModelList, blindModelRejection, blindCandidates, resolveTask,
    DEFAULT_BLIND_FALLBACKS,
} from '../src/db/ai-rules.js';

// An axios-shaped HTTP error: a response present means the request REACHED
// the server, which is what separates a status error from a socket fault.
const httpErr = (status, { data = null, headers = {} } = {}) => Object.assign(
    new Error(`Request failed with status code ${status}`),
    { isAxiosError: true, response: { status, data, headers } },
);

// --- aiErrorClass ------------------------------------------------------------

test('aiErrorClass treats 429 as retryable - the single biggest live failure class', () => {
    // 131 live 429s were classified permanent because openrouter.js retried on
    // isRetryableNetworkError, which matches ONLY responseless faults. Each one
    // fed the breaker, and five consecutive latched the whole sweep.
    assert.equal(aiErrorClass(httpErr(429)), 'retry');
    assert.equal(isRetryableAiError(httpErr(429)), true);
});

test('aiErrorClass retries the 5xx/timeout family', () => {
    for (const s of [408, 409, 425, 500, 502, 503, 504]) {
        assert.equal(aiErrorClass(httpErr(s)), 'retry', `status ${s} must be retryable`);
    }
});

test('aiErrorClass calls 404 model-missing, NOT a plain retry', () => {
    // OpenRouter answers 404 both for an unknown slug and for "no endpoint can
    // serve this request right now". Either way retrying the SAME slug is
    // pointless - the fallback chain is the answer, so 404 gets its own class.
    assert.equal(aiErrorClass(httpErr(404)), 'model-missing');
    assert.equal(isModelMissingError(httpErr(404)), true);
    assert.equal(isRetryableAiError(httpErr(404)), false);
});

test('aiErrorClass calls a retired slug model-missing even though it arrives as a 400', () => {
    // Probed live 2026-08-23: OpenRouter answers an unknown slug with 400
    // "<slug> is not a valid model ID", NOT 404. A model the vendor retires
    // therefore never reaches the 404 branch, so keying the fallback chain on
    // 404 alone would leave the exact "the slug is gone" case unprotected.
    const err = httpErr(400, {
        data: { error: { message: 'nvidia/this-slug-does-not-exist-9000 is not a valid model ID', code: 400 } },
    });
    assert.equal(aiErrorClass(err), 'model-missing');
    assert.equal(isModelMissingError(err), true);
});

test('aiErrorClass keeps an ordinary 400 permanent - only model-not-found 400s fall back', () => {
    // A malformed request must stay loud. Quietly re-sending it to every
    // fallback would turn one visible bug into a silent multi-model failure.
    const err = httpErr(400, { data: { error: { message: 'temperature must be a number', code: 400 } } });
    assert.equal(aiErrorClass(err), 'permanent');
    assert.equal(aiErrorClass(httpErr(400)), 'permanent');
});

test('aiErrorClass reads the 404 "no endpoints found" wording too', () => {
    const err = httpErr(404, { data: { error: { message: 'No endpoints found matching your data policy' } } });
    assert.equal(aiErrorClass(err), 'model-missing');
});

test('aiErrorClass keeps auth and moderation permanent (403 differs from the api-sports rule)', () => {
    // net-rules.js#isTransientHttpStatus retries 403 because API-Football's WAF
    // throttles with one. OpenRouter's 403 is a moderation refusal - retrying
    // it re-bills a prompt that will be refused again, so this predicate is
    // deliberately NOT that one.
    assert.equal(aiErrorClass(httpErr(403)), 'permanent');
    assert.equal(aiErrorClass(httpErr(401)), 'permanent');
    assert.equal(aiErrorClass(httpErr(400)), 'permanent');
});

test('aiErrorClass retries a responseless transport fault', () => {
    assert.equal(aiErrorClass(Object.assign(new Error('socket hang up'), { isAxiosError: true })), 'retry');
    assert.equal(aiErrorClass(Object.assign(new Error('reset'), { code: 'ECONNRESET' })), 'retry');
    assert.equal(aiErrorClass(Object.assign(new Error('dns'), { code: 'EAI_AGAIN' })), 'retry');
});

test('aiErrorClass is total against junk input', () => {
    assert.equal(aiErrorClass(null), 'permanent');
    assert.equal(aiErrorClass(undefined), 'permanent');
    assert.equal(aiErrorClass(new Error('plain')), 'permanent');
    assert.equal(aiErrorClass({}), 'permanent');
});

// --- aiRetryAfterMs ----------------------------------------------------------

test('aiRetryAfterMs reads OpenRouter\'s retry_after_seconds metadata', () => {
    // The exact live body shape, captured 2026-08-23 from z-ai/glm-5.2:free.
    const err = httpErr(429, {
        data: { error: { message: 'Provider returned error', code: 429, metadata: {
            raw: 'temporarily rate-limited upstream', retry_after_seconds: 5,
        } } },
    });
    assert.equal(aiRetryAfterMs(err), 5000);
});

test('aiRetryAfterMs falls back to the Retry-After header', () => {
    assert.equal(aiRetryAfterMs(httpErr(429, { headers: { 'retry-after': '3' } })), 3000);
});

test('aiRetryAfterMs bounds an absurd server hint and rejects a non-numeric one', () => {
    assert.equal(aiRetryAfterMs(httpErr(429, { headers: { 'retry-after': '99999' } }), { max: 30_000 }), 30_000);
    // An HTTP-date Retry-After is legal but not worth parsing: answer "no hint"
    // and let the caller's own backoff decide, rather than guess a delay.
    assert.equal(aiRetryAfterMs(httpErr(429, { headers: { 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' } })), null);
    assert.equal(aiRetryAfterMs(httpErr(429)), null);
    assert.equal(aiRetryAfterMs(null), null);
});

// --- chatReplyOutcome --------------------------------------------------------

test('chatReplyOutcome accepts a normal finished reply', () => {
    const o = chatReplyOutcome({ finish_reason: 'stop', message: { content: '{"a":1}' } });
    assert.equal(o.ok, true);
    assert.equal(o.reason, 'ok');
    assert.equal(o.text, '{"a":1}');
});

test('chatReplyOutcome flags finish_reason=length as truncated even with content', () => {
    // A reply cut at the ceiling is a cut JSON object; extractJson would fail
    // on it with a confusing syntax error at whatever character it stopped on.
    const o = chatReplyOutcome({ finish_reason: 'length', message: { content: '{"probabilit' } });
    assert.equal(o.ok, false);
    assert.equal(o.reason, 'truncated');
    assert.match(o.message, /truncated/i);
});

test('chatReplyOutcome names a reasoning-only reply as its own class', () => {
    // THE observed class: 30 live "carried no message content" plus 4
    // "truncated ... (0 chars)" are one root cause - a reasoning model spent
    // its whole completion budget thinking and emitted no content at all.
    const o = chatReplyOutcome({
        finish_reason: 'length',
        message: { content: '', reasoning: 'We need to output only a JSON object...' },
    });
    assert.equal(o.ok, false);
    assert.equal(o.reason, 'reasoning-only');
    assert.ok(o.reasoningChars > 0);
    assert.match(o.message, /reasoning/i);
});

test('chatReplyOutcome separates a plain empty reply from a reasoning-only one', () => {
    const o = chatReplyOutcome({ finish_reason: 'stop', message: { content: '   ' } });
    assert.equal(o.ok, false);
    assert.equal(o.reason, 'empty');
    assert.equal(o.reasoningChars, 0);
});

test('chatReplyOutcome is total against a missing choice or message', () => {
    for (const bad of [null, undefined, {}, { message: null }, 'nonsense']) {
        const o = chatReplyOutcome(bad);
        assert.equal(o.ok, false);
        assert.equal(typeof o.message, 'string');
        assert.ok(o.message.length > 0);
    }
});

test('chatReplyOutcome reports every retryable-reply class as incomplete, and only those', () => {
    // The retry policy keys on `retryable`: an incomplete reply is worth ONE
    // more attempt with a bigger budget; a well-formed reply never is.
    const cases = [
        [{ finish_reason: 'stop', message: { content: '{}' } }, false],
        [{ finish_reason: 'length', message: { content: '{' } }, true],
        [{ finish_reason: 'length', message: { content: '', reasoning: 'x' } }, true],
        [{ finish_reason: 'stop', message: { content: '' } }, true],
    ];
    for (const [choice, want] of cases) {
        assert.equal(chatReplyOutcome(choice).retryable, want, JSON.stringify(choice));
    }
});

// --- parseModelList ----------------------------------------------------------

test('parseModelList trims, drops blanks and de-duplicates in order', () => {
    assert.deepEqual(parseModelList(' a/one , b/two ,, a/one , '), ['a/one', 'b/two']);
    assert.deepEqual(parseModelList(''), []);
    assert.deepEqual(parseModelList(null), []);
    assert.deepEqual(parseModelList(undefined), []);
});

// --- blindModelRejection / blindCandidates -----------------------------------

test('blindModelRejection is the ONE vendor-independence rule', () => {
    assert.equal(blindModelRejection('nvidia/nemotron-3-super-120b-a12b:free', 'deepseek/deepseek-v4-flash-0731'), null);
    assert.equal(blindModelRejection('google/gemini-2.5-pro', 'deepseek/x'), 'google');
    assert.equal(blindModelRejection('google/gemma-4-31b-it:free', 'deepseek/x'), 'google');
    assert.equal(blindModelRejection('deepseek/deepseek-v4-flash-0731', 'deepseek/deepseek-v4-flash-0731'), 'same-vendor');
    assert.equal(blindModelRejection('', 'deepseek/x'), 'empty');
    assert.equal(blindModelRejection(null, 'deepseek/x'), 'empty');
});

test('blindCandidates puts the primary first and keeps only independent fallbacks', () => {
    const cfg = {
        OPENROUTER_MODEL: 'nvidia/nemotron-3-super-120b-a12b:free',
        AI_ANCHORED_MODEL: 'deepseek/deepseek-v4-flash-0731',
        AI_BLIND_MODEL_FALLBACKS: 'z-ai/glm-5.2:free,deepseek/deepseek-v4-flash-0731,google/gemma-4-31b-it:free,nvidia/nemotron-nano-9b-v2:free',
    };
    const { candidates, rejected } = blindCandidates(cfg);
    assert.deepEqual(candidates, [
        'nvidia/nemotron-3-super-120b-a12b:free',
        'z-ai/glm-5.2:free',
        'nvidia/nemotron-nano-9b-v2:free',
    ]);
    // A fallback that breaks reasoner independence is DROPPED, never used -
    // falling back to the anchored model's own vendor would quietly turn the
    // paired anchoring measurement into one lab agreeing with itself.
    assert.deepEqual(rejected.map(r => r.reason).sort(), ['google', 'same-vendor']);
});

test('blindCandidates de-duplicates a fallback that repeats the primary', () => {
    const cfg = {
        OPENROUTER_MODEL: 'nvidia/a', AI_ANCHORED_MODEL: 'deepseek/x',
        AI_BLIND_MODEL_FALLBACKS: 'nvidia/a, z-ai/b',
    };
    assert.deepEqual(blindCandidates(cfg).candidates, ['nvidia/a', 'z-ai/b']);
});

test('blindCandidates still throws on an invalid PRIMARY (fail fast stays fail fast)', () => {
    // A bad fallback is dropped quietly; a bad primary is a deterministic
    // misconfiguration enrichFixtures() must die on before billing anything.
    assert.throws(() => blindCandidates({ OPENROUTER_MODEL: 'google/gemini-2.5-pro' }), /google/i);
    assert.throws(
        () => blindCandidates({ OPENROUTER_MODEL: 'deepseek/x', AI_ANCHORED_MODEL: 'deepseek/y' }),
        /vendor/i,
    );
});

test('DEFAULT_BLIND_FALLBACKS is independent of both the Google ban and the DeepSeek anchor', () => {
    // The shipped default must be usable as-is against the shipped anchored
    // model, or the fallback chain would be empty exactly when it is needed.
    assert.ok(DEFAULT_BLIND_FALLBACKS.length >= 1);
    for (const m of DEFAULT_BLIND_FALLBACKS) {
        assert.equal(blindModelRejection(m, 'deepseek/deepseek-v4-flash-0731'), null, m);
    }
});

// --- resolveTask carries the chain ------------------------------------------

test('resolveTask blind carries its fallback chain; other tasks do not', () => {
    const cfg = {
        HOTPICK_AI_MODEL: 'openai/gpt-5.6-luna',
        OPENROUTER_MODEL: 'nvidia/nemotron-3-super-120b-a12b:free',
        AI_ANCHORED_MODEL: 'deepseek/deepseek-v4-flash-0731',
        AI_FACTS_MODEL: 'deepseek/deepseek-v4-flash-0731',
        AI_BLIND_MODEL_FALLBACKS: 'z-ai/glm-5.2:free',
        HOTPICK_AI_WEB: 0,
    };
    const blind = resolveTask('blind', cfg);
    assert.equal(blind.model, 'nvidia/nemotron-3-super-120b-a12b:free');
    assert.deepEqual(blind.fallbacks, ['z-ai/glm-5.2:free']);
    // The anchored/facts/adjudicate tasks have no independence requirement and
    // no chain - a fallback there would silently change what the tag measures.
    assert.equal(resolveTask('anchored', cfg).fallbacks, undefined);
    assert.equal(resolveTask('facts', cfg).fallbacks, undefined);
    assert.equal(resolveTask('adjudicate', cfg).fallbacks, undefined);
});
