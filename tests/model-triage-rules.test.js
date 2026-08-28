import test from 'node:test';
import assert from 'node:assert/strict';
import {
    isFreeModel, modelVendor, catalogCandidates, classifyRefusal, extractJsonObject,
    probeVerdict, scoreModel, rankModels, recommendForRole, DEFAULT_WEIGHTS,
} from '../src/db/model-triage-rules.js';

const free = (id, ctx = 100_000, out = 8_000) => ({
    id, context_length: ctx, pricing: { prompt: '0', completion: '0' }, top_provider: { max_completion_tokens: out },
});
const paid = id => ({
    id, context_length: 100_000, pricing: { prompt: '0.0000003', completion: '0.0000012' }, top_provider: { max_completion_tokens: 8_000 },
});

test('isFreeModel admits only models whose BOTH prices are zero', () => {
    assert.equal(isFreeModel(free('a/b:free')), true);
    assert.equal(isFreeModel(paid('a/b')), false);
    assert.equal(isFreeModel({ id: 'x', pricing: { prompt: '0' } }), false, 'missing completion price is not free');
    assert.equal(isFreeModel({ id: 'x', pricing: { prompt: 'abc', completion: '0' } }), false, 'unparseable price is not free');
    assert.equal(isFreeModel(null), false);
    assert.equal(isFreeModel({}), false);
});

test('modelVendor takes the slug prefix, case-folded', () => {
    assert.equal(modelVendor('z-ai/glm-5.2:free'), 'z-ai');
    assert.equal(modelVendor('NVIDIA/nemotron:free'), 'nvidia');
    assert.equal(modelVendor('bare-slug'), 'bare-slug');
    assert.equal(modelVendor(null), '');
});

test('catalogCandidates filters to free, honours vendor and size floors', () => {
    const models = [free('nvidia/a:free', 200_000, 9_000), paid('openai/b'), free('z-ai/c:free', 50_000, 4_000)];
    const all = catalogCandidates(models);
    assert.deepEqual(all.map(c => c.id), ['nvidia/a:free', 'z-ai/c:free'], 'paid model is dropped');

    const noNvidia = catalogCandidates(models, { excludeVendors: ['NVIDIA'] });
    assert.deepEqual(noNvidia.map(c => c.id), ['z-ai/c:free'], 'vendor exclusion is case-insensitive');

    const big = catalogCandidates(models, { minOutput: 8_000 });
    assert.deepEqual(big.map(c => c.id), ['nvidia/a:free'], 'small output ceiling is dropped');
    assert.deepEqual(catalogCandidates(models, { minContext: 100_000 }).map(c => c.id), ['nvidia/a:free']);
});

test('catalogCandidates ordering is deterministic by output, context, then slug', () => {
    const models = [free('b/x:free', 10, 100), free('a/y:free', 10, 100), free('c/z:free', 10, 500)];
    assert.deepEqual(catalogCandidates(models).map(c => c.id), ['c/z:free', 'a/y:free', 'b/x:free']);
});

test('catalogCandidates is total against junk input', () => {
    assert.deepEqual(catalogCandidates(null), []);
    assert.deepEqual(catalogCandidates(undefined), []);
    assert.deepEqual(catalogCandidates([{ pricing: { prompt: '0', completion: '0' } }]), [], 'a model with no id is dropped');
});

test('classifyRefusal catches self-referential declines, not domain vocabulary', () => {
    assert.equal(classifyRefusal("I can't help with that request.").refused, true);
    assert.equal(classifyRefusal('I am unable to assist here.').refused, true);
    assert.equal(classifyRefusal('As an AI, I must decline.').refused, true);
    // The exact false positive this must never produce: a real answer that
    // uses the domain's own words.
    assert.equal(classifyRefusal('{"verdict":"value","reason":"betting market underprices the gambling favourite"}').refused, false);
    assert.equal(classifyRefusal('').refused, false);
    assert.equal(classifyRefusal(null).refused, false);
});

test('classifyRefusal only inspects the head, so a trailing disclaimer is not a refusal', () => {
    const answer = `{"verdict":"value"}\n\n${'x'.repeat(500)}\nAs an AI, I note this is not financial advice.`;
    assert.equal(classifyRefusal(answer).refused, false);
});

test('extractJsonObject tolerates fences and surrounding prose', () => {
    assert.deepEqual(extractJsonObject('{"a":1}'), { a: 1 });
    assert.deepEqual(extractJsonObject('```json\n{"a":1}\n```'), { a: 1 });
    assert.deepEqual(extractJsonObject('Here you go: {"a":1} hope that helps'), { a: 1 });
    assert.equal(extractJsonObject('no json here'), null);
    assert.equal(extractJsonObject('[1,2,3]'), null, 'a bare array is not the object shape callers parse');
    assert.equal(extractJsonObject('{broken'), null);
    assert.equal(extractJsonObject(null), null);
});

test('probeVerdict passes a clean structured reply', () => {
    const v = probeVerdict({ ok: true, text: '{"verdict":"value","implied_probability":0.55,"reason":"x"}', ms: 900, requiredKeys: ['verdict', 'reason'] });
    assert.equal(v.pass, true);
    assert.equal(v.reason, 'ok');
    assert.deepEqual(v.criteria, { transport: true, content: true, json: true, no_refusal: true });
});

test('probeVerdict separates a budget-shaped failure from a dead endpoint', () => {
    const reasoning = probeVerdict({ ok: false, replyReason: 'reasoning-only', ms: 5_000 });
    assert.equal(reasoning.criteria.transport, true, 'the endpoint answered - it just had no budget left');
    assert.equal(reasoning.criteria.content, false);
    assert.equal(reasoning.pass, false);

    const dead = probeVerdict({ ok: false, error: 'ECONNREFUSED', ms: 20 });
    assert.equal(dead.criteria.transport, false);
    assert.equal(dead.reason, 'ECONNREFUSED');
});

test('probeVerdict fails a refusal even when it is valid JSON', () => {
    const v = probeVerdict({ ok: true, text: '{"reason":"I cannot help with betting questions"}', ms: 500 });
    assert.equal(v.criteria.no_refusal, false);
    assert.equal(v.pass, false);
    assert.match(v.reason, /^refused/);
});

test('probeVerdict fails prose and missing keys distinctly', () => {
    const prose = probeVerdict({ ok: true, text: 'The over looks fairly priced.', ms: 400 });
    assert.equal(prose.criteria.content, true);
    assert.equal(prose.criteria.json, false);
    assert.equal(prose.reason, 'reply was not JSON');

    const partial = probeVerdict({ ok: true, text: '{"verdict":"value"}', ms: 400, requiredKeys: ['verdict', 'reason'] });
    assert.equal(partial.criteria.json, false);
    assert.match(partial.reason, /missing keys: reason/);
});

test('probeVerdict treats whitespace-only content as empty', () => {
    const v = probeVerdict({ ok: true, text: '   \n  ', ms: 100 });
    assert.equal(v.criteria.content, false);
    assert.equal(v.reason, 'empty content');
});

test('scoreModel accepts only a model that passed EVERY probe', () => {
    const good = { criteria: { transport: true, content: true, json: true, no_refusal: true }, pass: true, ms: 1_000 };
    const bad = { criteria: { transport: true, content: true, json: false, no_refusal: true }, pass: false, ms: 1_000 };
    assert.equal(scoreModel([good, good]).accepted, true);
    assert.equal(scoreModel([good, bad]).accepted, false, 'four-out-of-five is a production failure waiting to happen');
    assert.equal(scoreModel([good, bad]).passRate, 0.5);
    assert.equal(scoreModel([]).accepted, false);
    assert.equal(scoreModel(null).score, 0);
});

test('scoreModel scores a faster model higher, all criteria equal', () => {
    const mk = ms => ({ criteria: { transport: true, content: true, json: true, no_refusal: true }, pass: true, ms });
    const fast = scoreModel([mk(1_000)]);
    const slow = scoreModel([mk(25_000)]);
    assert.ok(fast.score > slow.score, `${fast.score} should beat ${slow.score}`);
    assert.equal(fast.accepted && slow.accepted, true, 'latency never blocks acceptance on its own');
});

test('scoreModel latency contribution never goes negative past the budget', () => {
    const mk = ms => ({ criteria: { transport: true, content: true, json: true, no_refusal: true }, pass: true, ms });
    const s = scoreModel([mk(10_000_000)], { latencyBudgetMs: 1_000 });
    assert.ok(s.score >= 0, 'score stays in range');
    assert.ok(s.score > 0, 'a correct but very slow model still scores above zero');
});

test('DEFAULT_WEIGHTS rank a refusal below a slow correct answer', () => {
    assert.ok(DEFAULT_WEIGHTS.no_refusal > DEFAULT_WEIGHTS.latency);
    assert.ok(DEFAULT_WEIGHTS.json > DEFAULT_WEIGHTS.latency);
});

test('rankModels puts accepted models first regardless of raw score', () => {
    const ranked = rankModels([
        { id: 'b', accepted: false, score: 0.99, medianMs: 10 },
        { id: 'a', accepted: true, score: 0.50, medianMs: 900 },
    ]);
    assert.deepEqual(ranked.map(m => m.id), ['a', 'b']);
});

test('rankModels breaks ties deterministically by latency then slug', () => {
    const ranked = rankModels([
        { id: 'z', accepted: true, score: 0.9, medianMs: 100 },
        { id: 'a', accepted: true, score: 0.9, medianMs: 100 },
        { id: 'm', accepted: true, score: 0.9, medianMs: 50 },
    ]);
    assert.deepEqual(ranked.map(m => m.id), ['m', 'a', 'z']);
});

test('recommendForRole skips rejected models and honours the vendor exclusion', () => {
    const ranked = [
        { id: 'nvidia/top:free', accepted: true, score: 0.9 },
        { id: 'z-ai/next:free', accepted: true, score: 0.8 },
        { id: 'other/bad:free', accepted: false, score: 0.99 },
    ];
    assert.equal(recommendForRole(ranked).id, 'nvidia/top:free');
    assert.equal(recommendForRole(ranked, { excludeVendors: ['nvidia'] }).id, 'z-ai/next:free',
        'this is the blind-vs-anchored independence rule in practice');
    assert.equal(recommendForRole(ranked, { excludeVendors: ['nvidia', 'z-ai'] }), null);
    assert.equal(recommendForRole([]), null);
    assert.equal(recommendForRole(null), null);
});
