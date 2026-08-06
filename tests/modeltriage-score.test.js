import test from 'node:test';
import assert from 'node:assert/strict';
import {
    TASK_PROFILES, modelVendor, isFree, blendedCostPerCall, capabilityOf, valueScore,
    hardFilter, diffCatalog, uptimeOk, prosCons, rankCandidates, buildShortlist, planSwitch,
} from '../src/modeltriage/score.js';

// Offline tests for the PURE model-triage ranking rules (zero imports, the
// src/db/*-rules.js contract applied to the self-contained add-on).

const m = (id, over = {}) => ({
    id,
    name: id,
    vendor: modelVendor(id),
    created: 1750000000,
    context: 128000,
    pricing: { prompt: 0.0000005, completion: 0.0000015, web_search: null },
    structured: true,
    tools: true,
    free: id.endsWith(':free'),
    aa: 60,
    ...over,
});

test('modelVendor extracts the prefix, lowercased; slugless id is its own vendor', () => {
    assert.equal(modelVendor('OpenAI/gpt-5.6-luna'), 'openai');
    assert.equal(modelVendor('nvidia/nemotron-3-super-120b-a12b:free'), 'nvidia');
    assert.equal(modelVendor('mistral-large'), 'mistral-large');
    assert.equal(modelVendor(null), '');
});

test('isFree: :free suffix OR zero prompt+completion pricing', () => {
    assert.equal(isFree(m('a/x:free')), true);
    assert.equal(isFree(m('a/x', { free: false, pricing: { prompt: 0, completion: 0 } })), true);
    assert.equal(isFree(m('a/x', { free: false })), false);
});

test('blendedCostPerCall multiplies per-token pricing by the task token profile', () => {
    const cost = blendedCostPerCall({ prompt: 0.000001, completion: 0.000002 }, { tokensIn: 1000, tokensOut: 500 });
    assert.equal(cost, 0.000001 * 1000 + 0.000002 * 500); // 0.002
    // Missing pricing reads as 0 (free-tier rows carry "0" strings upstream).
    assert.equal(blendedCostPerCall({}, { tokensIn: 1000, tokensOut: 500 }), 0);
});

test('capabilityOf: AA index normalized 0..1, conservative default when absent', () => {
    assert.equal(capabilityOf(m('a/x', { aa: 60 })), 0.6);
    assert.equal(capabilityOf(m('a/x', { aa: null })), 0.35);
    assert.equal(capabilityOf(m('a/x', { aa: null }), 0.2), 0.2);
    assert.equal(capabilityOf(m('a/x', { aa: 250 })), 1); // clamped
});

test('valueScore: free is capability minus the flakiness tax; paid divides by cost', () => {
    const profile = TASK_PROFILES.blind;
    const free = m('nvidia/nemotron:free', { aa: 60 });
    const paid = m('openai/gpt-5.6-luna', { aa: 60, pricing: { prompt: 0.00001, completion: 0.00003 } });
    const vFree = valueScore(free, profile, { flakinessTax: 0.15 });
    assert.ok(Math.abs(vFree - 0.6 * 0.85) < 1e-9);
    // Paid twin with identical capability scores BELOW the taxed free model.
    assert.ok(valueScore(paid, profile, { flakinessTax: 0.15 }) < vFree);
    // Tax 0 = free is truly free (full capability).
    assert.equal(valueScore(free, profile, { flakinessTax: 0 }), 0.6);
    // A cheaper paid model beats a pricier one at equal capability.
    const cheap = m('deepseek/v4-flash', { aa: 60, pricing: { prompt: 0.0000001, completion: 0.0000002 } });
    assert.ok(valueScore(cheap, profile, {}) > valueScore(paid, profile, {}));
});

test('hardFilter enforces context floor, structured outputs and web-composability', () => {
    const profile = TASK_PROFILES.adjudicate; // needsStructured + needsWeb
    assert.equal(hardFilter(m('a/x'), profile).ok, true);
    assert.equal(hardFilter(m('a/x', { context: 4000 }), profile).ok, false);
    assert.equal(hardFilter(m('a/x', { structured: false }), profile).ok, false);
    assert.equal(hardFilter(m('a/x', { tools: false }), profile).ok, false);
    // reasons name every failed gate
    const r = hardFilter(m('a/x', { context: 4000, structured: false }), profile);
    assert.equal(r.reasons.length, 2);
});

test('hardFilter blind: bans Google models and the anchored vendor', () => {
    const profile = TASK_PROFILES.blind;
    assert.equal(hardFilter(m('google/gemini-3-pro'), profile).ok, false);
    assert.equal(hardFilter(m('someone/gemma-4-27b'), profile).ok, false);
    assert.equal(hardFilter(m('deepseek/v4-flash'), profile, { blindVendorBan: 'deepseek' }).ok, false);
    assert.equal(hardFilter(m('nvidia/nemotron:free'), profile, { blindVendorBan: 'deepseek' }).ok, true);
});

test('diffCatalog reports added / delisted / price_changed', () => {
    const prev = [m('a/one'), m('a/two'), m('a/three')];
    const next = [m('a/one'), m('a/three', { pricing: { prompt: 0.000002, completion: 0.0000015, web_search: null } }), m('a/four')];
    const d = diffCatalog(prev, next);
    assert.deepEqual(d.added.map(x => x.id), ['a/four']);
    assert.deepEqual(d.delisted.map(x => x.id), ['a/two']);
    assert.equal(d.price_changed.length, 1);
    assert.equal(d.price_changed[0].id, 'a/three');
    assert.equal(d.price_changed[0].before.prompt, 0.0000005);
    assert.equal(d.price_changed[0].after.prompt, 0.000002);
});

test('uptimeOk: floor gate, unknown uptime passes (absence of evidence)', () => {
    assert.equal(uptimeOk(99.4), true);
    assert.equal(uptimeOk(80), false);
    assert.equal(uptimeOk(null), true);
    assert.equal(uptimeOk(95, 96), false);
});

test('rankCandidates filters hard requirements then sorts by value score desc', () => {
    const models = [
        m('a/strong', { aa: 80 }),
        m('b/weak', { aa: 30 }),
        m('c/toosmall', { aa: 90, context: 1000 }),
    ];
    const ranked = rankCandidates(models, 'anchored', {});
    assert.deepEqual(ranked.map(r => r.model.id), ['a/strong', 'b/weak']);
    assert.ok(ranked[0].score > ranked[1].score);
});

test('buildShortlist: PRIMARY needs a fully-passed qualification + uptime; unqualified never primary', () => {
    const models = [m('a/best', { aa: 90 }), m('b/good', { aa: 70 }), m('c/ok', { aa: 50 })];
    const quals = {
        'b/good': { passes: 3, uptime: 99, probes: {} },
        'c/ok': { passes: 3, uptime: 99, probes: {} },
        // a/best has NO qualification yet -> cannot be primary despite top score
    };
    const s = buildShortlist({ models, quals, routing: { anchored: 'b/good' }, opts: {} });
    const t = s.tasks.anchored;
    assert.equal(t.candidates[0].id, 'a/best'); // still shown, top-ranked
    assert.equal(t.primary, 'b/good');           // but primary is the qualified one
    assert.equal(t.fallback, 'c/ok');
    // A failed probe disqualifies from primary too.
    const s2 = buildShortlist({
        models, routing: {},
        quals: { 'a/best': { passes: 2, uptime: 99, probes: {} }, 'b/good': { passes: 3, uptime: 99, probes: {} } },
        opts: {},
    });
    assert.equal(s2.tasks.anchored.primary, 'b/good');
});

test('buildShortlist: blind task excludes the anchored routing vendor', () => {
    const models = [m('deepseek/v4-flash', { aa: 90 }), m('nvidia/nemo:free', { aa: 60 })];
    const s = buildShortlist({ models, quals: {}, routing: { anchored: 'deepseek/v4-flash' }, opts: {} });
    assert.deepEqual(s.tasks.blind.candidates.map(c => c.id), ['nvidia/nemo:free']);
});

test('planSwitch: switches at most ONE task, best-first, and only to qualified primaries', () => {
    const models = [m('x/adj', { aa: 90 }), m('y/facts', { aa: 90 })];
    const quals = {
        'x/adj': { passes: 3, uptime: 99, probes: {} },
        'y/facts': { passes: 3, uptime: 99, probes: {} },
    };
    const routing = { adjudicate: 'old/adj', facts: 'old/facts', blind: 'nvidia/nemo:free', anchored: 'deepseek/v4' };
    const shortlist = buildShortlist({ models, quals, routing, opts: {} });
    const sw = planSwitch({ shortlist, routing, quals, opts: {} });
    assert.ok(sw);
    assert.equal(sw.task, 'adjudicate'); // first task in profile order wins the one slot
    assert.equal(sw.settingKey, 'HOTPICK_AI_MODEL');
    assert.equal(sw.from, 'old/adj');
    assert.equal(sw.to, 'x/adj');
});

test('planSwitch: null when the primary already IS the live model or lacks qualification', () => {
    // Live routing always carries all four tasks in practice - pin them all
    // to the sole qualified candidate so no task has a differing primary.
    const models = [m('x/adj', { aa: 90 })];
    const routing = { adjudicate: 'x/adj', facts: 'x/adj', blind: 'x/adj', anchored: 'x/adj' };
    const okQual = { 'x/adj': { passes: 3, uptime: 99, probes: {} } };
    const s1 = buildShortlist({ models, quals: okQual, routing, opts: {} });
    assert.equal(planSwitch({ shortlist: s1, routing, quals: okQual, opts: {} }), null);
    // Unqualified candidate: no primary at all -> no switch.
    const r2 = { adjudicate: 'old/adj', facts: 'old/facts', blind: 'old/blind', anchored: 'old/anch' };
    const s2 = buildShortlist({ models, quals: {}, routing: r2, opts: {} });
    assert.equal(planSwitch({ shortlist: s2, routing: r2, quals: {}, opts: {} }), null);
});

test('planSwitch: refuses a blind/anchored vendor collision post-switch', () => {
    // Candidate for anchored shares a vendor with the LIVE blind model. Pin
    // it as the live model everywhere else so the ONLY differing task is
    // anchored - the one the post-switch vendor guard must refuse.
    const models = [m('nvidia/big-reasoner', { aa: 95 })];
    const quals = { 'nvidia/big-reasoner': { passes: 3, uptime: 99, probes: {} } };
    const routing = {
        adjudicate: 'nvidia/big-reasoner', facts: 'nvidia/big-reasoner',
        blind: 'nvidia/big-reasoner', anchored: 'deepseek/v4',
    };
    const shortlist = buildShortlist({ models, quals, routing, opts: {} });
    assert.equal(shortlist.tasks.anchored.primary, 'nvidia/big-reasoner');
    assert.equal(planSwitch({ shortlist, routing, quals, opts: {} }), null);
});

test('prosCons names price, context, JSON enforcement, uptime, benchmark and probes', () => {
    const qual = { passes: 3, uptime: 99.5, probes: { json: { pass: true }, reason: { pass: true }, latency: { pass: true, ms: 900 } } };
    const { pros, cons } = prosCons(m('a/x:free', { aa: 82 }), TASK_PROFILES.blind, qual);
    assert.ok(pros.some(p => /free/i.test(p)));
    assert.ok(pros.some(p => /json|structured/i.test(p)));
    assert.ok(pros.some(p => /benchmark|intelligence/i.test(p)));
    assert.ok(cons.some(c => /flak|rate|cap/i.test(c)));
    const noQual = prosCons(m('a/y', { aa: null, structured: false }), TASK_PROFILES.bulk, null);
    assert.ok(noQual.cons.some(c => /benchmark/i.test(c)));
    assert.ok(noQual.cons.some(c => /probe|unqualified|not yet/i.test(c)));
});

test('TASK_PROFILES carry the routing setting keys; bulk is advisory-only', () => {
    assert.equal(TASK_PROFILES.adjudicate.settingKey, 'HOTPICK_AI_MODEL');
    assert.equal(TASK_PROFILES.facts.settingKey, 'AI_FACTS_MODEL');
    assert.equal(TASK_PROFILES.blind.settingKey, 'AI_BLIND_MODEL');
    assert.equal(TASK_PROFILES.anchored.settingKey, 'AI_ANCHORED_MODEL');
    assert.equal(TASK_PROFILES.bulk.settingKey, null);
});
