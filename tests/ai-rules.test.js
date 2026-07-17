// Pure M4.1 enrichment rules (src/db/ai-rules.js): prompt builders, per-kind
// schemas, model-tag math, task->provider/model resolution. Zero network/DB.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    FACT_SCHEMA_VER, PROMPT_VERSION, BLIND_MARKETS, buildBlindPrompt, buildAnchoredPrompt,
    FactsPayload, BlindPayload, AnchoredPayload, normalizeProbabilities, enrichModelTag,
    effectivePromptVersion, resolveTask,
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
    const outcomesLine = p.split('\n').find(line => line.startsWith('Outcomes: '));
    assert.ok(outcomesLine, 'prompt must have an "Outcomes: " line');
    const listed = outcomesLine.slice('Outcomes: '.length).split(', ');
    assert.deepEqual(listed, BLIND_MARKETS);
});

// --- Finding 1 (M4.1 final review): real rolling stats, defensively wired --
// A genuinely sample-less side (n:0, everything else null - exactly what
// teamGoalsAggregates/h2hGoalsAggregates return for a team/pair with no
// qualifying history) must OMIT its stats line entirely, never render the
// literal word "null" (the pre-fix hardcoded placeholder's failure mode:
// "Home: last 0 games - avg total goals null, scored null/game...").

const ZERO_SAMPLE_TEAM = { n: 0, avgTotal: null, gfAvg: null, gaAvg: null, bttsRate: null };

test('buildBlindPrompt omits a zero-sample team stats line entirely (no null-rendering)', () => {
    const p = buildBlindPrompt({ ...FIXTURE, home: ZERO_SAMPLE_TEAM });
    assert.ok(!p.includes('Home:'), 'a zero-sample Home line must be omitted entirely, not rendered with nulls');
    assert.ok(!/\bnull\b/.test(p), 'prompt must never render the literal word "null"');
    assert.ok(p.includes('Away:'), 'a populated Away line must still render');
});

test('buildAnchoredPrompt omits a zero-sample team stats line entirely (no null-rendering)', () => {
    const p = buildAnchoredPrompt({ ...FIXTURE, tip: { market: '1X', price: 1.4 }, away: ZERO_SAMPLE_TEAM });
    assert.ok(!p.includes('Away:'), 'a zero-sample Away line must be omitted entirely, not rendered with nulls');
    assert.ok(!/\bnull\b/.test(p), 'prompt must never render the literal word "null"');
    assert.ok(p.includes('Home:'), 'a populated Home line must still render');
});

test('buildBlindPrompt omits BOTH team lines and keeps a friendly H2H line when nothing has a sample', () => {
    const p = buildBlindPrompt({ ...FIXTURE, home: ZERO_SAMPLE_TEAM, away: ZERO_SAMPLE_TEAM, h2h: { n: 0, avgTotal: null } });
    assert.ok(!p.includes('Home:') && !p.includes('Away:'));
    assert.ok(p.includes('no prior meetings known'), 'H2H already substitutes friendly text for a zero sample');
    assert.ok(!/\bnull\b/.test(p));
    // the rest of the prompt must be unaffected by the omission (no stray
    // blank-line collapse, no truncation)
    assert.ok(p.includes('Arsenal - Chelsea'));
    assert.ok(p.includes('Outcomes:'));
});

test('buildBlindPrompt never leaks facts.extra (free-form text can carry odds)', () => {
    const p = buildBlindPrompt({ ...FIXTURE, facts: { extra: { note: 'bookmaker price 1.40 on the home win' } } });
    for (const banned of ['odds', 'price', 'bookmaker', 'tip', 'break-even', 'vig', '1.40']) {
        assert.ok(!p.toLowerCase().includes(banned), `blind prompt must not leak "${banned}" via facts.extra`);
    }
});

test('buildBlindPrompt never leaks a free-text motivation.home_stakes (screened, not just typed)', () => {
    const p = buildBlindPrompt({
        ...FIXTURE,
        facts: { motivation: { home_stakes: 'must win; market has them near 1.40' } },
    });
    for (const banned of ['odds', 'price', 'bookmaker', 'tip', 'break-even', 'vig', '1.40']) {
        assert.ok(!p.toLowerCase().includes(banned), `blind prompt must not leak "${banned}" via motivation.home_stakes`);
    }
});

test('buildBlindPrompt screens key-absence names for a leaked price mention, keeping clean names', () => {
    const p = buildBlindPrompt({
        ...FIXTURE,
        facts: { availability: { home_key_absences: ['striker priced 1.40 to score', 'J. Doe'] } },
    });
    for (const banned of ['odds', 'price', 'bookmaker', 'tip', 'break-even', 'vig', '1.40']) {
        assert.ok(!p.toLowerCase().includes(banned), `blind prompt must not leak "${banned}" via home_key_absences`);
    }
    assert.ok(p.includes('J. Doe'), 'a clean absence name must survive screening');
});

// THE IDENTICAL-EVIDENCE CONTRACT. Extracts the two-line "Verified context"
// block from each prompt and asserts the anchored prompt contains the blind
// prompt's block byte-for-byte. A `facts.extra` note is included on purpose:
// before the fix, `buildAnchoredPrompt` kept `extra` while `buildBlindPrompt`
// dropped it, so the two fact blocks diverged and this assertion caught
// exactly that gap (anchored "knowing" something blind didn't). Substring
// containment (rather than a looser "both mention X" check) is what pins the
// blocks as identical rather than merely overlapping.
function _factsBlockOf(prompt) {
    const idx = prompt.indexOf('Verified context (from an earlier grounded research pass):');
    if (idx === -1) return null;
    return prompt.slice(idx).split('\n').slice(0, 2).join('\n');
}

test('blind and anchored prompts see byte-identical fact evidence (the paired-measurement contract)', () => {
    const facts = FactsPayload.parse({
        availability: { home_key_absences: ['J. Doe'] },
        extra: { note: 'an analyst note that must never reach a prompt' },
    });
    const blind = buildBlindPrompt({ ...FIXTURE, facts });
    const anchored = buildAnchoredPrompt({ ...FIXTURE, facts, tip: { market: '1X', price: 1.4 } });
    const blindBlock = _factsBlockOf(blind);
    assert.ok(blindBlock, 'blind prompt must carry a facts block for this test to be meaningful');
    assert.ok(anchored.includes(blindBlock), 'anchored prompt must contain the EXACT same facts block as blind');
});

test('prompt omits the facts header entirely when the screened projection is empty (extra-only facts)', () => {
    const p = buildBlindPrompt({ ...FIXTURE, facts: { extra: { note: 'x' } } });
    assert.ok(!p.includes('Verified context'));
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

test('normalizeProbabilities sums to 1 within 1e-9 even when equal shares do not round exactly', () => {
    const out = normalizeProbabilities({ 1: 1, X: 1, 2: 1 });
    assert.ok(Math.abs(out['1'] + out['X'] + out['2'] - 1) < 1e-9);
});

test('normalizeProbabilities writes null (not NaN) back for a non-finite member', () => {
    const out = normalizeProbabilities({ 1: 0.5, X: NaN, 2: 0.3 });
    assert.equal(out['X'], null);
    assert.ok(Number.isFinite(out['1']));
    assert.ok(Number.isFinite(out['2']));
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

test('FactsPayload coerces an out-of-vocabulary stakes value to null WITHOUT throwing, and still parses the rest', () => {
    assert.doesNotThrow(() => FactsPayload.parse({
        motivation: { home_stakes: 'must win; market has them near 1.40', away_stakes: 'normal', rotation_risk: 'high' },
    }));
    const parsed = FactsPayload.parse({
        motivation: { home_stakes: 'must win; market has them near 1.40', away_stakes: 'normal', rotation_risk: 'high' },
    });
    assert.equal(parsed.motivation.home_stakes, null);
    assert.equal(parsed.motivation.away_stakes, 'normal');
    assert.equal(parsed.motivation.rotation_risk, 'high');
});

test('FactsPayload keeps `extra` for persistence even though no prompt ever sees it', () => {
    const parsed = FactsPayload.parse({ extra: { note: 'bookmaker price 1.40 on the home win' } });
    assert.deepEqual(parsed.extra, { note: 'bookmaker price 1.40 on the home win' });

    const blind = buildBlindPrompt({ ...FIXTURE, facts: parsed });
    const anchored = buildAnchoredPrompt({ ...FIXTURE, facts: parsed, tip: { market: '1X', price: 1.4 } });
    assert.ok(!blind.includes('1.40'), 'blind prompt must not carry the persisted extra note');
    assert.ok(!anchored.includes('1.40'), 'anchored prompt must not carry the persisted extra note either');
});

test('FactsPayload defaults a BOOLEAN fact field to null, never false (absent != no)', () => {
    const parsed = FactsPayload.parse({});
    assert.equal(parsed.availability.top_scorer_out, null);
    assert.notEqual(parsed.availability.top_scorer_out, false);
});

test('AnchoredPayload parses a real reply and defaults sensibly', () => {
    const parsed = AnchoredPayload.parse({ probability: 62, consensus: 'lean_on', reason: 'home form' });
    assert.equal(parsed.probability, 0.62);
    assert.equal(parsed.consensus, 'lean_on');
    assert.equal(parsed.reason, 'home form');

    const empty = AnchoredPayload.parse({});
    assert.equal(empty.probability, null);
    assert.equal(empty.consensus, null);
    assert.equal(empty.reason, '');
});

test('BlindPayload rejects a probability outside 0..1 but rescales percentages', () => {
    assert.equal(BlindPayload.parse({ probabilities: { 1: 65 } }).probabilities['1'], 0.65);
    assert.throws(() => BlindPayload.parse({ probabilities: { 1: -1 } }));
});

// Finding 1: the prompt materially changed (real rolling stats replace the
// hardcoded null placeholder) - PROMPT_VERSION must have moved past the
// value the 5 already-banked rows were stamped with, so they re-fire rather
// than being trusted as "already enriched with real stats".
test('PROMPT_VERSION was bumped past the pre-fix value (Finding 1 forces a re-enrich)', () => {
    assert.equal(PROMPT_VERSION, 2);
});

test('enrichModelTag encodes model + grounding + prompt version', () => {
    assert.equal(enrichModelTag({ model: 'gemini-2.5-flash', grounded: true, promptVersion: 1 }),
        'gemini-2.5-flash+search#e1');
    assert.equal(enrichModelTag({ model: 'openai/gpt-5.6-terra', grounded: false, promptVersion: 1 }),
        'openai/gpt-5.6-terra#e1');
});

test('effectivePromptVersion: preamble activation bumps the tag version, off = base (T10a regime math)', () => {
    assert.equal(effectivePromptVersion(false), PROMPT_VERSION, 'dark default: unchanged tag');
    assert.equal(effectivePromptVersion(true), PROMPT_VERSION + 1, 'a changed prompt must never wear the old tag');
    assert.equal(effectivePromptVersion(true, 7), 8);
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

test('resolveTask routes adjudicate to Gemini on the adjudicator model + grounding (T9 harness migration)', () => {
    // Byte-identical to what gemini.js#_adjudicate hardcoded pre-harness:
    // model = HOTPICK_AI_MODEL, grounded = Boolean(HOTPICK_AI_WEB) - the #p3
    // reuse tag depends on this mapping never drifting.
    const cfg = { HOTPICK_AI_MODEL: 'gemini-2.5-flash', HOTPICK_AI_WEB: 1 };
    assert.deepEqual(resolveTask('adjudicate', cfg),
        { provider: 'gemini', model: 'gemini-2.5-flash', grounded: true });
});

test('resolveTask adjudicate grounding follows HOTPICK_AI_WEB off too', () => {
    const cfg = { HOTPICK_AI_MODEL: 'gemini-2.5-flash', HOTPICK_AI_WEB: 0 };
    assert.deepEqual(resolveTask('adjudicate', cfg),
        { provider: 'gemini', model: 'gemini-2.5-flash', grounded: false });
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

test('resolveTask refuses a Google model for the blind task (reasoner independence is required, not advisory)', () => {
    const cfg = { HOTPICK_AI_MODEL: 'gemini-2.5-flash', AI_BLIND_MODEL: 'google/gemini-2.5-pro' };
    assert.throws(() => resolveTask('blind', cfg), /non-google|google/i);
});

test('resolveTask names the ACTUAL source key in the blind Google-model guard, not always AI_BLIND_MODEL', () => {
    // AI_BLIND_MODEL unset -> the model resolved from OPENROUTER_MODEL; the
    // error must say so, or an operator would edit the wrong env key.
    const cfg = { OPENROUTER_MODEL: 'google/gemini-2.5-pro' };
    assert.throws(() => resolveTask('blind', cfg), /OPENROUTER_MODEL "google\/gemini-2.5-pro"/);
});
