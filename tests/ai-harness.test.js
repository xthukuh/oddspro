import test from 'node:test';
import assert from 'node:assert/strict';

import { callStructured, AiGuardOpen } from '../src/ai/harness.js';
import { Verdict } from '../src/ai-parse.js';
import { newRunGuard, recordCall } from '../src/db/ai-guard-rules.js';

// The callStructured harness (T9) - exercised entirely through the deps DI
// seam (injected callModel/getProvider/now), so no network and no .env keys
// are ever touched. The pure decision math it delegates to is covered in
// tests/ai-guard-rules.test.js; these tests pin the PIPELINE: guard check ->
// call -> sanitize -> extractJson -> schema.parse -> flags.

const REPLY = '{"verdict":"confirm","probability":0.7,"checks":{"context":"verified league match"},"reason":"solid recent form"}';

function fakeCall(text, extra = {}) {
    return async () => ({ text, sources: [], provider: 'gemini', model: 'test-model', grounded: false, ...extra });
}

test('happy path: parses the reply through the schema and passes call metadata through', async () => {
    const sources = [{ title: 't', uri: 'u' }];
    const r = await callStructured({
        task: 'adjudicate', prompt: 'p', schema: Verdict,
        deps: { callModel: fakeCall(REPLY, { sources, grounded: true }) },
    });
    assert.equal(r.data.verdict, 'confirm');
    assert.equal(r.data.probability, 0.7);
    assert.deepEqual(r.sources, sources);
    assert.equal(r.provider, 'gemini');
    assert.equal(r.model, 'test-model');
    assert.equal(r.grounded, true);
    assert.deepEqual(r.flags, []);
});

test('tolerates markdown-fenced JSON (extractJson contract)', async () => {
    const r = await callStructured({
        task: 'adjudicate', prompt: 'p', schema: Verdict,
        deps: { callModel: fakeCall('```json\n' + REPLY + '\n```') },
    });
    assert.equal(r.data.verdict, 'confirm');
});

test('sanitizes control characters out of the reply and flags them', async () => {
    const dirty = REPLY.slice(0, 10) + String.fromCharCode(1) + REPLY.slice(10);
    const r = await callStructured({
        task: 'adjudicate', prompt: 'p', schema: Verdict,
        deps: { callModel: fakeCall(dirty) },
    });
    assert.equal(r.data.verdict, 'confirm', 'still parses after the strip');
    assert.ok(r.flags.includes('control-chars'));
});

test('surfaces observe-only suspicion flags without rejecting the reply', async () => {
    const r = await callStructured({
        task: 'adjudicate', prompt: 'p', schema: Verdict,
        deps: { callModel: fakeCall('{"verdict":"confirm","reason":""}') },
    });
    assert.equal(r.data.verdict, 'confirm', 'flags never veto - the scorecard judges patterns');
    assert.ok(r.flags.includes('empty-reason-confirm'));
});

test('throws on a reply with no JSON object (caller fails open)', async () => {
    await assert.rejects(() => callStructured({
        task: 'adjudicate', prompt: 'p', schema: Verdict,
        deps: { callModel: fakeCall('I cannot answer that.') },
    }), /no JSON object/i);
});

test('throws on a schema violation (zod is the single authority on shape)', async () => {
    await assert.rejects(() => callStructured({
        task: 'adjudicate', prompt: 'p', schema: Verdict,
        deps: { callModel: fakeCall('{"verdict":"maybe"}') },
    }));
});

test('records success and failure into the run guard', async () => {
    const guard = newRunGuard(0);
    await callStructured({
        task: 'adjudicate', prompt: 'p', schema: Verdict, guard,
        deps: { callModel: fakeCall(REPLY) },
    });
    assert.equal(guard.calls, 1);
    assert.equal(guard.consecFailures, 0);
    await assert.rejects(() => callStructured({
        task: 'adjudicate', prompt: 'p', schema: Verdict, guard,
        deps: { callModel: async () => { throw new Error('ECONNRESET'); } },
    }), /ECONNRESET/);
    assert.equal(guard.calls, 2);
    assert.equal(guard.failures, 1);
    assert.equal(guard.consecFailures, 1);
});

test('parse failures count toward the breaker exactly like transport failures', async () => {
    const guard = newRunGuard(0);
    await assert.rejects(() => callStructured({
        task: 'adjudicate', prompt: 'p', schema: Verdict, guard,
        deps: { callModel: fakeCall('no json here') },
    }));
    assert.equal(guard.consecFailures, 1, 'an unusable reply is "not answering usably"');
});

test('refuses instantly with AiGuardOpen once the breaker trips - the model is never dialed', async () => {
    const guard = newRunGuard(0);
    for (let i = 0; i < 5; i++) recordCall(guard, { transportError: true });
    let dialed = 0;
    await assert.rejects(() => callStructured({
        task: 'adjudicate', prompt: 'p', schema: Verdict, guard,
        cfg: { AI_BREAKER_AFTER: 5, AI_RUN_MAX_MINUTES: 0 },
        deps: { callModel: async () => { dialed++; return { text: REPLY }; } },
    }), e => e instanceof AiGuardOpen && e.reason === 'breaker-open');
    assert.equal(dialed, 0, 'a refused call must not burn a 60s timeout');
});

test('refuses with AiGuardOpen once the wall-clock budget is spent', async () => {
    const guard = newRunGuard(0);
    let dialed = 0;
    await assert.rejects(() => callStructured({
        task: 'adjudicate', prompt: 'p', schema: Verdict, guard,
        cfg: { AI_RUN_MAX_MINUTES: 10, AI_BREAKER_AFTER: 5 },
        deps: { callModel: async () => { dialed++; return { text: REPLY }; }, now: () => 11 * 60_000 },
    }), e => e instanceof AiGuardOpen && e.reason === 'budget-exhausted');
    assert.equal(dialed, 0);
});

test('no guard = no refusal (the guard is opt-in per run)', async () => {
    const r = await callStructured({
        task: 'adjudicate', prompt: 'p', schema: Verdict,
        deps: { callModel: fakeCall(REPLY) },
    });
    assert.equal(r.data.verdict, 'confirm');
});

// --- consensus mode ----------------------------------------------------------

const PANEL = [
    { provider: 'gemini', model: 'g1' },
    { provider: 'openrouter', model: 'o1' },
    { provider: 'openrouter', model: 'o2' },
];

function panelProvider(replyByModel, calls = []) {
    return () => ({
        complete: async ({ model, prompt, grounded }) => {
            calls.push({ model, prompt, grounded });
            const reply = replyByModel[model];
            if (reply instanceof Error) throw reply;
            return { text: reply, sources: [] };
        },
    });
}

test('consensus: majority verdict wins, ensemble metadata replaces the single-model identity', async () => {
    const r = await callStructured({
        task: 'adjudicate', prompt: 'p', schema: Verdict,
        consensus: { models: PANEL, minAgree: 2, numericTol: 0.1 },
        deps: {
            getProvider: panelProvider({
                g1: '{"verdict":"confirm","probability":0.70,"reason":"a"}',
                o1: '{"verdict":"confirm","probability":0.74,"reason":"b"}',
                o2: '{"verdict":"veto","probability":0.30,"reason":"c"}',
            }),
        },
    });
    assert.equal(r.data.verdict, 'confirm');
    assert.ok(Math.abs(r.data.probability - 0.72) < 1e-9, 'mean of the agreeing legs');
    assert.equal(r.provider, 'consensus');
    assert.equal(r.model, 'consensus(g1+o1+o2)@2');
    assert.equal(r.grounded, false);
});

test('consensus legs run UNGROUNDED (only Gemini grounds; a grounded panel is incoherent)', async () => {
    const calls = [];
    await callStructured({
        task: 'adjudicate', prompt: 'p', schema: Verdict,
        consensus: { models: PANEL.slice(0, 2), minAgree: 2 },
        deps: {
            getProvider: panelProvider({
                g1: '{"verdict":"confirm","reason":"a"}',
                o1: '{"verdict":"confirm","reason":"a"}',
            }, calls),
        },
    });
    assert.equal(calls.length, 2);
    assert.ok(calls.every(c => c.grounded === undefined), 'grounded never passed to a leg');
});

test('consensus: disagreement throws - consensus never guesses', async () => {
    await assert.rejects(() => callStructured({
        task: 'adjudicate', prompt: 'p', schema: Verdict,
        consensus: { models: PANEL.slice(0, 2), minAgree: 2 },
        deps: {
            getProvider: panelProvider({
                g1: '{"verdict":"confirm","reason":"a"}',
                o1: '{"verdict":"veto","reason":"b"}',
            }),
        },
    }), /consensus/i);
});

test('consensus: a failed leg is dropped, the surviving majority still resolves', async () => {
    const r = await callStructured({
        task: 'adjudicate', prompt: 'p', schema: Verdict,
        consensus: { models: PANEL, minAgree: 2 },
        deps: {
            getProvider: panelProvider({
                g1: '{"verdict":"veto","reason":"a"}',
                o1: new Error('timeout'),
                o2: '{"verdict":"veto","reason":"c"}',
            }),
        },
    });
    assert.equal(r.data.verdict, 'veto');
});

test('consensus: refuses a single-vendor panel (cross-vendor is a hard requirement)', async () => {
    let dialed = 0;
    await assert.rejects(() => callStructured({
        task: 'adjudicate', prompt: 'p', schema: Verdict,
        consensus: { models: [{ provider: 'openrouter', model: 'a' }, { provider: 'openrouter', model: 'b' }], minAgree: 2 },
        deps: { getProvider: () => ({ complete: async () => { dialed++; return { text: REPLY }; } }) },
    }), /cross-vendor/i);
    assert.equal(dialed, 0, 'refused before any leg is billed');
});
