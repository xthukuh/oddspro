// Pure M4.1 enrichment rules (src/db/ai-rules.js): prompt builders, per-kind
// schemas, model-tag math, task->provider/model resolution. Zero network/DB.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    FACT_SCHEMA_VER, BLIND_MARKETS, buildBlindPrompt, buildAnchoredPrompt,
    FactsPayload, BlindPayload, normalizeProbabilities, enrichModelTag, resolveTask,
} from '../src/db/ai-rules.js';

const FIXTURE = {
    fixture: 'Arsenal - Chelsea', kickoff: '2026-07-20 18:00:00', league: 'Premier League',
    home: { n: 8, avgTotal: 2.9, gfAvg: 1.8, gaAvg: 1.1, bttsRate: 0.6 },
    away: { n: 8, avgTotal: 2.4, gfAvg: 1.2, gaAvg: 1.2, bttsRate: 0.5 },
    h2h: { n: 3, avgTotal: 3.1 },
};

// THE ANCHORING GUARD. The whole blind-vs-anchored measurement is void if a
// price or our tip leaks into the blind prompt.
test('buildBlindPrompt leaks no odds, no price and no tip', () => {
    const p = buildBlindPrompt(FIXTURE);
    for (const banned of ['odds', 'price', 'bookmaker', 'tip', 'break-even', 'vig']) {
        assert.ok(!p.toLowerCase().includes(banned), `blind prompt must not mention "${banned}"`);
    }
    assert.ok(p.includes('Arsenal - Chelsea'));
});

test('buildBlindPrompt asks for exactly the fixed market set', () => {
    const p = buildBlindPrompt(FIXTURE);
    for (const m of BLIND_MARKETS) assert.ok(p.includes(m), `blind prompt must ask about ${m}`);
});

test('buildAnchoredPrompt DOES carry the tip and price (that is the point)', () => {
    const p = buildAnchoredPrompt({ ...FIXTURE, tip: { market: '1X', price: 1.4 } });
    assert.ok(p.includes('1X'));
    assert.ok(p.includes('1.4'));
});

test('normalizeProbabilities renormalizes each family to 1 (never trust the model)', () => {
    const out = normalizeProbabilities({ 1: 0.5, X: 0.3, 2: 0.4, 'O 2.5': 0.6, 'U 2.5': 0.6, GG: 0.5, NG: 0.1 });
    assert.ok(Math.abs(out['1'] + out['X'] + out['2'] - 1) < 1e-9);
    assert.ok(Math.abs(out['O 2.5'] + out['U 2.5'] - 1) < 1e-9);
    assert.ok(Math.abs(out['GG'] + out['NG'] - 1) < 1e-9);
});

test('normalizeProbabilities leaves a family alone when it is absent or all-zero', () => {
    const out = normalizeProbabilities({ 1: 0, X: 0, 2: 0 });
    assert.deepEqual(out, { 1: null, X: null, 2: null });
});

test('FactsPayload distinguishes absent evidence from "no problem found"', () => {
    const parsed = FactsPayload.parse({});
    assert.equal(parsed.availability.home_out_count, null); // absent, NOT 0
    assert.equal(parsed.schema_ver, FACT_SCHEMA_VER);
});

test('FactsPayload tolerates unknown extra keys (the escape hatch)', () => {
    const parsed = FactsPayload.parse({ extra: { weather: 'storm' } });
    assert.deepEqual(parsed.extra, { weather: 'storm' });
});

test('BlindPayload rejects a probability outside 0..1 but rescales percentages', () => {
    assert.equal(BlindPayload.parse({ probabilities: { 1: 65 } }).probabilities['1'], 0.65);
    assert.throws(() => BlindPayload.parse({ probabilities: { 1: -1 } }));
});

test('enrichModelTag encodes model + grounding + prompt version', () => {
    assert.equal(enrichModelTag({ model: 'gemini-2.5-flash', grounded: true, promptVersion: 1 }),
        'gemini-2.5-flash+search#e1');
    assert.equal(enrichModelTag({ model: 'openai/gpt-5.6-terra', grounded: false, promptVersion: 1 }),
        'openai/gpt-5.6-terra#e1');
});

test('resolveTask routes facts+anchored to Gemini and the blind reasoner off-Google', () => {
    const cfg = { HOTPICK_AI_MODEL: 'gemini-2.5-flash', OPENROUTER_MODEL: 'openai/gpt-5.6-terra',
        HOTPICK_AI_WEB: 1, AI_BLIND_MODEL: '', AI_ANCHORED_MODEL: '' };
    assert.deepEqual(resolveTask('facts', cfg),
        { provider: 'gemini', model: 'gemini-2.5-flash', grounded: true });
    assert.deepEqual(resolveTask('blind', cfg),
        { provider: 'openrouter', model: 'openai/gpt-5.6-terra', grounded: false });
    assert.deepEqual(resolveTask('anchored', cfg),
        { provider: 'gemini', model: 'gemini-2.5-flash', grounded: true });
});

test('resolveTask honours per-task model overrides', () => {
    const cfg = { HOTPICK_AI_MODEL: 'gemini-2.5-flash', OPENROUTER_MODEL: 'openai/gpt-5.6-terra',
        HOTPICK_AI_WEB: 0, AI_BLIND_MODEL: 'qwen/qwen3.7-plus', AI_ANCHORED_MODEL: 'gemini-2.5-pro' };
    assert.equal(resolveTask('blind', cfg).model, 'qwen/qwen3.7-plus');
    assert.equal(resolveTask('anchored', cfg).model, 'gemini-2.5-pro');
    assert.equal(resolveTask('facts', cfg).grounded, false);
});

test('resolveTask throws on an unknown task (a typo must be loud)', () => {
    assert.throws(() => resolveTask('nonsense', {}), /unknown ai task/i);
});
