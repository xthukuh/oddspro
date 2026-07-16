// AI provider seam (src/ai/index.js) - routing + the fail-open contract.
// No network: providers are exercised through resolveTask, and the HTTP
// clients are not invoked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getProvider, callModel } from '../src/ai/index.js';
import { resolveTask } from '../src/db/ai-rules.js';
import { isRetryableNetworkError } from '../src/db/net-rules.js';

test('getProvider returns a provider exposing complete()', () => {
    for (const name of ['gemini', 'openrouter']) {
        assert.equal(typeof getProvider(name).complete, 'function');
    }
});

test('getProvider throws on an unknown provider (a typo must be loud)', () => {
    assert.throws(() => getProvider('nope'), /unknown ai provider/i);
});

test('the blind task never routes to a Google model (reasoner independence)', () => {
    const cfg = { HOTPICK_AI_MODEL: 'gemini-2.5-flash', OPENROUTER_MODEL: 'openai/gpt-5.6-terra',
        HOTPICK_AI_WEB: 1, AI_BLIND_MODEL: '', AI_ANCHORED_MODEL: '' };
    const blind = resolveTask('blind', cfg);
    assert.equal(blind.provider, 'openrouter');
    assert.ok(!/google|gemini|gemma/i.test(blind.model));
});

// Spec 4: retry classification. Transport faults self-heal; a model replying
// nonsense is NOT a transport fault and must not be retried (it would just
// re-bill the same bad answer).
test('retry classification: transport errors retry, bad replies do not', () => {
    assert.equal(isRetryableNetworkError({ code: 'ECONNRESET' }), true);
    assert.equal(isRetryableNetworkError(new Error('AI reply carried no JSON object: blah')), false);
});

// Spec 4: failures PROPAGATE out of callModel (the orchestrator's try/catch is
// what fails open). Routed through an unknown task so the assertion is fully
// OFFLINE - `npm test` must never touch the network, and a real
// OPENROUTER_API_KEY in .env would otherwise make this fire a live request.
test('callModel propagates a routing failure rather than resolving silently', async () => {
    await assert.rejects(() => callModel({ task: 'nonsense', prompt: 'x', cfg: {} }),
        /unknown ai task/i);
});
