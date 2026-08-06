import test from 'node:test';
import assert from 'node:assert/strict';
import { PROBES, evaluateProbe, runProbes } from '../src/modeltriage/qualify.js';

// Offline tests for the qualification probes: pure evaluators + runProbes
// with a stubbed call (no network, no key).

test('PROBES: three probes with prompts (json contract / reasoning / latency echo)', () => {
    assert.deepEqual(PROBES.map(p => p.key), ['json', 'reason', 'latency']);
    for (const p of PROBES) assert.ok(p.prompt.length > 10, `${p.key} needs a prompt`);
});

test('json probe: strict contract, fenced JSON tolerated, wrong sum rejected', () => {
    assert.equal(evaluateProbe('json', '{"ok":true,"sum":7}').pass, true);
    assert.equal(evaluateProbe('json', 'Sure! ```json\n{"ok":true,"sum":7}\n```').pass, true);
    assert.equal(evaluateProbe('json', '{"ok":true,"sum":8}').pass, false);
    assert.equal(evaluateProbe('json', '{"ok":true}').pass, false);
    assert.equal(evaluateProbe('json', 'I cannot answer that.').pass, false);
});

test('reason probe: known-answer check', () => {
    assert.equal(evaluateProbe('reason', '{"total":3,"over25":true}').pass, true);
    assert.equal(evaluateProbe('reason', '{"total":3,"over25":false}').pass, false);
    assert.equal(evaluateProbe('reason', '{"total":4,"over25":true}').pass, false);
});

test('latency probe: exact echo, chatter rejected', () => {
    assert.equal(evaluateProbe('latency', 'OK').pass, true);
    assert.equal(evaluateProbe('latency', ' ok\n').pass, true);
    assert.equal(evaluateProbe('latency', 'OK, here is a long explanation of my reasoning...').pass, false);
});

test('runProbes: all-pass stub -> 3 passes with latencies recorded', async () => {
    const replies = {
        json: '{"ok":true,"sum":7}',
        reason: '{"total":3,"over25":true}',
        latency: 'OK',
    };
    let calls = 0;
    const call = async ({ model, prompt }) => {
        calls++;
        assert.equal(model, 'a/x');
        const probe = PROBES.find(p => p.prompt === prompt);
        return { text: replies[probe.key] };
    };
    const q = await runProbes('a/x', { call });
    assert.equal(calls, 3);
    assert.equal(q.model, 'a/x');
    assert.equal(q.passes, 3);
    for (const key of ['json', 'reason', 'latency']) {
        assert.equal(q.probes[key].pass, true);
        assert.equal(typeof q.probes[key].ms, 'number');
    }
});

test('runProbes: a throwing call (empty reply / transport) records a fail, never rejects', async () => {
    const call = async ({ prompt }) => {
        if (prompt === PROBES[0].prompt) throw new Error('OpenRouter reply carried no message content');
        return { text: prompt === PROBES[1].prompt ? '{"total":3,"over25":true}' : 'OK' };
    };
    const q = await runProbes('a/x', { call });
    assert.equal(q.passes, 2);
    assert.equal(q.probes.json.pass, false);
    assert.match(q.probes.json.note, /no message content/);
});

test('runProbes: latency over budget fails the latency probe even on a correct echo', async () => {
    // Budget 0ms: every measured latency exceeds it; only the latency probe cares.
    const q = await runProbes('a/x', { call: async ({ prompt }) => {
        await new Promise(r => setTimeout(r, 5));
        const probe = PROBES.find(p => p.prompt === prompt);
        return { text: { json: '{"ok":true,"sum":7}', reason: '{"total":3,"over25":true}', latency: 'OK' }[probe.key] };
    }, maxLatencyMs: 0 });
    assert.equal(q.probes.json.pass, true);
    assert.equal(q.probes.reason.pass, true);
    assert.equal(q.probes.latency.pass, false);
    assert.match(q.probes.latency.note, /latency/i);
});

test('runProbes: a bare-string call reply is accepted too', async () => {
    const call = async ({ prompt }) => {
        const probe = PROBES.find(p => p.prompt === prompt);
        return { json: '{"ok":true,"sum":7}', reason: '{"total":3,"over25":true}', latency: 'OK' }[probe.key];
    };
    const q = await runProbes('a/x', { call });
    assert.equal(q.passes, 3);
});
