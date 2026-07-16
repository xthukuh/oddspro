import { z } from 'zod';

// Pure M4.1 enrichment rules: prompt builders, per-kind payload schemas,
// model-tag math and task->provider/model resolution. Imports zod only - no
// config/.env/DB - so it is fully offline-testable, the same contract as every
// other src/db/*-rules.js module. src/ai/* owns the HTTP; this owns the words
// and the shapes.
//
// Collection only: nothing here feeds bestTip, confidence or any ranking.

// Bump to re-enrich upcoming fixtures (reuse is keyed on the model tag).
export const PROMPT_VERSION = 1;

// Bump when the fact payload gains a field. schema_ver + a JSON payload is the
// deliberate answer to "leave room for anything we may need later": a new fact
// costs a version bump, NOT a forward-only migration.
export const FACT_SCHEMA_VER = 1;

// A blind call has not seen our tip, so it cannot be asked about "our tip". It
// emits a distribution over this fixed set instead, comparable to any tip we
// later made. Families are normalized by us, never trusted from the model.
export const BLIND_MARKETS = Object.freeze(['1', 'X', '2', 'O 2.5', 'U 2.5', 'GG', 'NG']);
const FAMILIES = [['1', 'X', '2'], ['O 2.5', 'U 2.5'], ['GG', 'NG']];

const _team = (label, t) => `${label}: last ${t.n} games - avg total goals ${t.avgTotal},`
    + ` scored ${t.gfAvg}/game, conceded ${t.gaAvg}/game, both-teams-scored rate ${t.bttsRate}`;

// Any leaked price/betting mention, wherever a grounded model might have
// written free text. `extra` (FactsPayload.extra) is the obvious channel,
// but motivation.home_stakes/away_stakes/rotation_risk and the key-absence
// name arrays are ALSO free-form strings authored by the same grounded,
// web-searching model - typed *shape* is not vetted *content*. The stakes/
// rotation fields are additionally enum-constrained at the schema level
// (see FactsPayload below), so this regex is defense in depth for them, and
// the ONLY guard for the one remaining free-text leaf class: absence names.
const _LEAK_RE = /odds|price|bookmaker|vig|break-even|betting|\d+\.\d+/i;

// Recurses through plain objects/arrays; a leaky string leaf becomes null
// (object leaf) or is dropped entirely (array element, so a clean sibling
// name survives with nothing left marking where the leaky one was).
// Non-string leaves and already-null values pass through untouched.
function _screenLeaks(value) {
    if (typeof value === 'string') return _LEAK_RE.test(value) ? null : value;
    if (Array.isArray(value)) return value.map(_screenLeaks).filter(v => v !== null);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, _screenLeaks(v)]));
    }
    return value;
}

// ONE shared fact projection used by BOTH prompts (blind and anchored).
// `extra` (FactsPayload.extra) is the unvetted free-form escape hatch - it
// stays PERSISTED in the parsed payload for later analysis/promotion to
// typed fields (Task 6), but it never reaches a prompt, blind OR anchored.
// Everything else is screened through `_screenLeaks` before either prompt
// sees it. Because both prompts call this SAME function over the SAME
// `facts` argument, the fact block they carry is byte-identical by
// construction - the only asymmetry left in this module is the tip/price
// block `buildAnchoredPrompt` appends afterward. That is what makes
// `anchored - blind` a clean paired measurement of the anchoring effect
// (spec: "both reasoners work the identical evidence, so any disagreement
// is reasoning difference rather than one model simply knowing more").
const _promptFacts = facts => {
    if (!facts) return [];
    const { extra, ...rest } = facts;
    const safe = _screenLeaks(rest);
    if (!safe || Object.keys(safe).length === 0) return [];
    return ['Verified context (from an earlier grounded research pass):', JSON.stringify(safe)];
};

// BLIND: no odds, no price, no tip, no bookmaker - by construction. The moment
// a prompt mentions those, the model anchors, which is the exact bias being
// measured. tests/ai-rules.test.js asserts this directly.
export function buildBlindPrompt({ fixture, kickoff, league, home, away, h2h, facts }) {
    return [
        'You are a football analyst. Estimate outcome probabilities for the match',
        'below from the evidence given. Judge the match on its merits.',
        '',
        `Fixture: ${fixture}`,
        `League: ${league ?? 'unknown'}`,
        `Kickoff: ${kickoff}`,
        _team('Home', home),
        _team('Away', away),
        `Head-to-head: ${h2h?.n ? `last ${h2h.n} meetings - avg total goals ${h2h.avgTotal}` : 'no prior meetings known'}`,
        ..._promptFacts(facts),
        '',
        'Estimate P for EVERY outcome below. 1 = home win, X = draw, 2 = away win,',
        '"O 2.5"/"U 2.5" = over/under 2.5 total goals, GG/NG = both teams score yes/no.',
        `Outcomes: ${BLIND_MARKETS.join(', ')}`,
        '',
        'Reply with ONLY a JSON object, no other text:',
        '{"probabilities":{"1":0.0-1.0,"X":0.0-1.0,"2":0.0-1.0,"O 2.5":0.0-1.0,',
        ' "U 2.5":0.0-1.0,"GG":0.0-1.0,"NG":0.0-1.0},',
        ' "reason":"one short sentence naming the decisive factor"}',
    ].join('\n');
}

// ANCHORED: sees the SAME screened facts as blind (via `_promptFacts` - see
// its comment), plus the tip/price block below. That block is the ONLY
// asymmetry versus buildBlindPrompt. anchored - blind on the same fixture
// and model is a PAIRED measurement of the anchoring effect.
export function buildAnchoredPrompt({ fixture, kickoff, league, tip, home, away, h2h, facts }) {
    return [
        'You are a football analyst reviewing one candidate bet.',
        '',
        `Fixture: ${fixture}`,
        `League: ${league ?? 'unknown'}`,
        `Kickoff: ${kickoff}`,
        _team('Home', home),
        _team('Away', away),
        `Head-to-head: ${h2h?.n ? `last ${h2h.n} meetings - avg total goals ${h2h.avgTotal}` : 'no prior meetings known'}`,
        ..._promptFacts(facts),
        '',
        `Candidate bet: ${tip.market} at bookmaker price ${tip.price}.`,
        '',
        'Give your probability that this bet WINS, and read the public/market',
        'consensus: is the money concentrated on this outcome?',
        '',
        'Reply with ONLY a JSON object, no other text:',
        '{"probability":0.0-1.0,"consensus":"heavy_on"|"lean_on"|"neutral"|"lean_against"|"heavy_against",',
        ' "reason":"one short sentence naming the decisive factor"}',
    ].join('\n');
}

// Models reply in percentages despite a 0..1 contract; rescale 65 -> 0.65
// rather than discard an otherwise good answer. Mirrors src/ai-parse.js#_prob
// (duplicated deliberately, NOT because purity forbids the import - zod-only
// pure modules importing from other zod-only pure modules is sanctioned
// precedent, e.g. tip-rules.js -> markets.js#canonicalMarket. The real
// reasons: ai-parse.js does not export its `_prob`, the two schemas serve
// independent contracts free to diverge over time, and it is ~6 lines).
const _prob = z.preprocess(v => {
    if (v == null) return null;
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    return n > 1 && n <= 100 ? n / 100 : n;
}, z.number().min(0).max(1).nullable());

const _nn = z.number().nullish().transform(v => v ?? null);
const _nb = z.boolean().nullish().transform(v => v ?? null);

// Tolerant enum: an out-of-vocabulary value (including a leaky free-form
// sentence like "must win; market has them near 1.40") degrades to `null`
// via preprocess rather than failing the whole payload - fail-open, not a
// hard throw, so one odd field never discards an otherwise-good facts call.
// This is ALSO what keeps home_stakes/away_stakes/rotation_risk out of the
// leak-screening burden for typed FactsPayload callers: they cannot carry
// free text at all once parsed, by construction, not by caller discipline.
const _enum = values => z.preprocess(
    v => (typeof v === 'string' && values.includes(v) ? v : null),
    z.enum(values).nullable(),
);
const _stakes = _enum(['dead_rubber', 'must_win', 'title_race', 'relegation', 'secured', 'normal']);
const _rotationRisk = _enum(['low', 'medium', 'high']);

// Fact payload v1. EVERY field nullable: absent evidence must stay
// distinguishable from "no problem found" - a 0 would assert a fact we never
// verified.
//
// Simplified from the brief's nested-default sketch (flagged there as fiddly):
// each section is `.optional()` and, when present, has every field default to
// null via `.default(null)` on each leaf rather than a nested pipe/transform
// chain. Behaviour is identical - only the plumbing got simpler.
const AvailabilitySection = z.object({
    home_out_count: _nn,
    away_out_count: _nn,
    home_key_absences: z.array(z.string()).nullish().transform(v => v ?? null),
    away_key_absences: z.array(z.string()).nullish().transform(v => v ?? null),
    top_scorer_out: _nb,
    first_choice_gk_out: _nb,
});
const AVAILABILITY_EMPTY = { home_out_count: null, away_out_count: null,
    home_key_absences: null, away_key_absences: null, top_scorer_out: null, first_choice_gk_out: null };

const MotivationSection = z.object({
    home_stakes: _stakes, away_stakes: _stakes, rotation_risk: _rotationRisk,
});
const MOTIVATION_EMPTY = { home_stakes: null, away_stakes: null, rotation_risk: null };

const CongestionSection = z.object({
    home_days_since_last: _nn, away_days_since_last: _nn, bigger_match_within_4d: _nb,
});
const CONGESTION_EMPTY = { home_days_since_last: null, away_days_since_last: null, bigger_match_within_4d: null };

const LineupSection = z.object({
    xi_confirmed: _nb, manager_change_recent: _nb, gk_change: _nb,
});
const LINEUP_EMPTY = { xi_confirmed: null, manager_change_recent: null, gk_change: null };

export const FactsPayload = z.object({
    availability: AvailabilitySection.nullish().transform(v => v ?? { ...AVAILABILITY_EMPTY }),
    motivation: MotivationSection.nullish().transform(v => v ?? { ...MOTIVATION_EMPTY }),
    congestion: CongestionSection.nullish().transform(v => v ?? { ...CONGESTION_EMPTY }),
    lineup: LineupSection.nullish().transform(v => v ?? { ...LINEUP_EMPTY }),
    extra: z.record(z.string(), z.unknown()).nullish().transform(v => v ?? null),
}).partial().transform(v => ({
    schema_ver: FACT_SCHEMA_VER,
    availability: v.availability ?? { ...AVAILABILITY_EMPTY },
    motivation: v.motivation ?? { ...MOTIVATION_EMPTY },
    congestion: v.congestion ?? { ...CONGESTION_EMPTY },
    lineup: v.lineup ?? { ...LINEUP_EMPTY },
    extra: v.extra ?? null,
}));

export const BlindPayload = z.object({
    probabilities: z.record(z.string(), _prob).nullish().transform(v => v ?? {}),
    reason: z.string().nullish().transform(v => v ?? ''),
});

export const AnchoredPayload = z.object({
    probability: _prob.optional().transform(v => v ?? null),
    consensus: z.string().nullish().transform(v => v ?? null),
    reason: z.string().nullish().transform(v => v ?? ''),
});

// Renormalize each family to sum 1. The model's raw numbers routinely do not.
// An absent or all-zero family stays null - we do NOT invent a uniform prior.
// No rounding here: this is data, not display - a 4dp round can make a
// 3-way family (0.3333 x3 = 0.9999) fail its own "sums to 1" contract.
// Round at the point of display, never in the stored/measured value.
export function normalizeProbabilities(probs) {
    const out = { ...probs };
    for (const family of FAMILIES) {
        const present = family.filter(k => out[k] != null && Number.isFinite(Number(out[k])));
        if (!present.length) continue;
        const sum = present.reduce((a, k) => a + Number(out[k]), 0);
        for (const k of family) {
            if (out[k] == null) continue;
            // A non-finite member (e.g. NaN slipping in from an upstream parse)
            // must resolve to null like any other missing value, never write
            // NaN back - `present` already excludes it from the sum.
            if (!Number.isFinite(Number(out[k]))) { out[k] = null; continue; }
            out[k] = sum > 0 ? Number(out[k]) / sum : null;
        }
    }
    return out;
}

// Reuse is keyed on this tag, so switching model, grounding or prompt version
// re-enriches upcoming fixtures automatically. '#e<N>' keeps the enrichment
// namespace distinct from the adjudicator's '#p<N>'.
export function enrichModelTag({ model, grounded, promptVersion = PROMPT_VERSION }) {
    return `${model}${grounded ? '+search' : ''}#e${promptVersion}`;
}

// task -> { provider, model, grounded }. Facts are extracted ONCE by the
// grounded model; both reasoners then work identical evidence, so disagreement
// is reasoning difference rather than one model simply knowing more.
export function resolveTask(task, cfg) {
    const grounded = Boolean(cfg.HOTPICK_AI_WEB);
    if (task === 'facts') {
        return { provider: 'gemini', model: cfg.HOTPICK_AI_MODEL, grounded };
    }
    if (task === 'blind') {
        // Non-Google by requirement: reasoner independence is the property the
        // consensus signal rests on - two Google models is Gemini agreeing with
        // itself. Enforced HERE, not just documented, because AI_BLIND_MODEL is
        // free-form env config and a valid OpenRouter slug
        // (`google/gemini-2.5-pro`) would otherwise silently defeat it.
        const model = cfg.AI_BLIND_MODEL || cfg.OPENROUTER_MODEL;
        // Name the source key that actually resolved the model - the model may
        // have fallen through to OPENROUTER_MODEL, and an operator chasing the
        // error by editing AI_BLIND_MODEL would otherwise be editing the wrong
        // key.
        const src = cfg.AI_BLIND_MODEL ? 'AI_BLIND_MODEL' : 'OPENROUTER_MODEL';
        if (model && /gemini|google|gemma/i.test(model)) {
            throw new Error(`${src} "${model}" is a Google model - the blind reasoner must be `
                + 'non-Google so it is an independent check on the (Google) anchored/facts reasoner, '
                + 'not the same model agreeing with itself.');
        }
        return { provider: 'openrouter', model, grounded: false };
    }
    if (task === 'anchored') {
        return { provider: 'gemini', model: cfg.AI_ANCHORED_MODEL || cfg.HOTPICK_AI_MODEL, grounded };
    }
    throw new Error(`unknown ai task: ${task}`);
}

// TZ HAZARD FIX (Task 6 review finding 1): fixtures.kickoff is a naive EAT
// (+03:00) wall-clock DATETIME. mysql2 decodes a BARE DATETIME column into a
// JS Date using the NODE PROCESS's local timezone to read those wall-clock
// digits - NOT the pinned SQL session '+03:00' (that setting only governs
// server-side functions like NOW(), never how the client driver decodes
// column bytes). Off-EAT (e.g. a UTC host), that Date represents a DIFFERENT
// instant than the true kickoff, so selectEnrichable's `new Date(r.kickoff)`
// below could admit a fixture that already kicked off up to 3h ago - the
// exact silent, FLATTERING leakage this whole module exists to prevent
// (a grounded call on a played match retrieves the final score).
//
// The fix: `_loadTargets` (src/enrich.js) must never hand selectEnrichable a
// bare/naive kickoff. This DATE_FORMAT expression bakes the '+03:00' offset
// into the projected STRING itself, so `new Date()` parses it as an ABSOLUTE
// instant on ANY host, EAT or not - ISO 8601 strings carrying an explicit
// offset are unambiguous by spec. DO NOT "simplify" this back to a bare
// `f.kickoff` select - see tests/enrich-rules.test.js's TZ HAZARD test,
// which pins this exact string and demonstrates the failure mode it closes.
export const KICKOFF_SQL_EXPR = "DATE_FORMAT(f.kickoff, '%Y-%m-%dT%H:%i:%s+03:00')";

// CORRELATION GUARDS (Task 6 review finding 3): plain SQL-fragment strings,
// not a db.raw()-wrapped function, so this file stays zod-imports-only;
// `_loadTargets` (src/enrich.js) applies them itself via its own db.raw().
// Mirrored VERBATIM from hotpicks.js's own upcoming-fixture target loader
// (src/hotpicks.js:129-130, updateHotPicks) - duplicated deliberately (same
// "not because purity forbids the import" precedent as this file's own
// `_prob`, which duplicates ai-parse.js's), because hotpicks.js is not a
// pure module this file can import from. An uncorrelated fixture (no linked
// bookmaker match) or one with no pre-match snapshot (history backfill never
// ran, so bestTip has nothing to blend) can never produce a usable tip, so
// `needAnchored` stays false and the fixture would burn a facts+blind call
// for nothing while occupying an AI_ENRICH_CAP slot a pairable fixture could
// have used - exactly the unpaired-blind waste the cap exists to prevent.
export const CORRELATION_GUARDS = [
    'EXISTS (SELECT 1 FROM matches m WHERE m.fixture_id = f.id)',
    'EXISTS (SELECT 1 FROM fixture_prematch p WHERE p.fixture_id = f.id)',
];

// REUSE-FRESHNESS CHECK (Task 6 review finding 2): reuse is keyed on
// (fixture, kind, provider, model_tag) PLUS tip identity for 'anchored' rows.
// bestTip re-updates an upcoming fixture's tip_market/tip_price on EVERY
// hotpicks run, so a changed tip must re-fire the anchored call even when
// model_tag is unchanged - otherwise the stored anchored payload silently
// keeps measuring anchoring against a tip the model never actually saw,
// mis-attributing the paired anchored-minus-blind measurement to the wrong
// bet. 'blind' never sees a tip (by construction - the whole point of a
// blind reasoner), so it is judged on model_tag alone; `currentTip` is
// ignored for it.
//
// `stored` is `{ model_tag, tip }` (tip only meaningful for 'anchored');
// `tip` is `{ market, price } | null`. A legacy anchored row written before
// this fix carries no `tip` at all - that must compare UNEQUAL to any real
// current tip so it re-fires exactly once to backfill what it should have
// recorded from the start, rather than being trusted forever on faith.
//
// `tip_price` is a DECIMAL(8,2) column - mysql2 hands it back as a STRING
// ('1.85'), so price identity is compared numerically, not by strict ===.
export function insightIsFresh(kind, wantModelTag, stored, currentTip) {
    if (!stored || stored.model_tag !== wantModelTag) return false;
    if (kind !== 'anchored') return true;
    const storedTip = stored.tip;
    if (!storedTip || storedTip.market !== currentTip?.market) return false;
    const a = storedTip.price, b = currentTip?.price;
    if (a == null || b == null) return a == null && b == null;
    return Number(a) === Number(b);
}

// THE invariant that protects everything: an AI call must never touch a
// past-kickoff fixture. A grounded call on a played match retrieves the final
// score - leakage that RESEMBLES brilliance, and fails silently. This is the
// same freeze idiom as fixture_prematch / tips / hot picks, kept pure so it is
// asserted by a test rather than trusted as a convention.
// Strictly greater-than: a fixture kicking off exactly now is NOT upcoming.
export function selectEnrichable(rows, now = Date.now()) {
    return rows
        .filter(r => new Date(r.kickoff).getTime() > now)
        .sort((a, b) => new Date(a.kickoff) - new Date(b.kickoff)); // soonest first
}

// Bound FIXTURES per run, not calls: one fixture always gets its full 3-call
// set or none. A blind with no anchored is useless for the paired measurement.
export function capFixtures(rows, cap) {
    return cap > 0 ? rows.slice(0, cap) : [];
}
