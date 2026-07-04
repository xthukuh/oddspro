import axios from 'axios';
import { z } from 'zod';
import { config } from './config.js';

// Optional Google Gemini adjudicators, both fail-open (absent key or any API
// failure keeps the rule-based verdict - the features never depend on the AI
// being up), both confirm/veto only (the AI can never promote a pick):
// - adjudicateHotPick: last gate for over-2.5 candidates that already passed
//   every deduction rule (a handful of calls per day at most);
// - reviewTip: same idea for the top-confidence tips (capped per run).
// With HOTPICK_AI_WEB=1 requests attach Gemini's native google_search tool,
// letting verdicts cite real-world context the warehouse cannot see
// (injuries, rotation, dead rubbers). Grounded requests bill extra per call.
// (Replaced OpenRouter 2026-07-04: stronger default reasoner + real Google
// Search grounding; the stored ai_model tag records what produced a verdict.)

export function aiEnabled() {
    return Boolean(config.GEMINI_API_KEY);
}

// Tag stored in ai_model/tip_ai_model - verdict reuse is keyed on it, so
// switching model or grounding automatically re-adjudicates upcoming rows.
export function aiModelTag() {
    return config.HOTPICK_AI_MODEL + (config.HOTPICK_AI_WEB ? '+search' : '');
}

// Gemini generateContent response envelope (validated - external data).
// Tolerant on purpose: grounded replies may split text across parts, and
// safety-blocked candidates can arrive without content at all.
const GeminiEnvelope = z.object({
    candidates: z.array(z.object({
        content: z.object({
            parts: z.array(z.object({ text: z.string().optional() })).nullable().optional(),
        }).nullable().optional(),
    })).min(1),
});

const Verdict = z.object({
    verdict: z.enum(['confirm', 'veto']),
    // Gemini sometimes omits the reason on confirms - tolerate it
    reason: z.string().nullish().transform(v => v ?? ''),
});

// Extract the reply's JSON object, tolerating markdown code fences.
function _parseVerdict(content) {
    const m = /\{[\s\S]*\}/.exec(content);
    if (!m) throw new Error(`AI reply carried no JSON object: ${content}`);
    return Verdict.parse(JSON.parse(m[0]));
}

// One verdict round-trip: prompt in, { verdict, reason, model } out.
// Throws on any failure; callers record ai_verdict 'error' and keep the rule
// verdict (fail-open). No JSON response mode - it can't be combined with the
// google_search tool, so the prompt demands JSON and _parseVerdict extracts.
async function _adjudicate(prompt) {
    const res = await axios.post(
        `${config.GEMINI_URL}/models/${config.HOTPICK_AI_MODEL}:generateContent`,
        {
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0 },
            ...(config.HOTPICK_AI_WEB ? { tools: [{ google_search: {} }] } : {}),
        },
        {
            headers: {
                'x-goog-api-key': config.GEMINI_API_KEY,
                'Content-Type': 'application/json',
            },
            timeout: 60_000, // grounded calls run searches before answering
        },
    );
    const parsed = GeminiEnvelope.parse(res.data);
    const content = (parsed.candidates[0].content?.parts ?? []).map(p => p.text ?? '').join('');
    const out = _parseVerdict(content);
    return { ...out, reason: out.reason.substring(0, 512), model: aiModelTag() };
}

// Ask the model to confirm or veto one over-2.5 candidate given the full
// signal breakdown.
//   { fixture, kickoff, league, home, away, h2h, market, api }
//   home/away: teamGoalsAggregates() results; h2h: h2hGoalsAggregates()
export async function adjudicateHotPick({ fixture, kickoff, league, home, away, h2h, market, api }) {
    const team = (label, t) =>
        `${label}: last ${t.n} games - avg total ${t.avgTotal}, over-2.5 rate ${t.overRate},`
        + ` scored ${t.gfAvg}/game, conceded ${t.gaAvg}/game, both-teams-scored rate ${t.bttsRate}`;
    const prompt = [
        'You are the final reviewer of an over-2.5-goals shortlist. A strict rule engine',
        'already verified every quantitative gate (rolling goal averages, over rates,',
        'sample sizes, market probability floor, no contradictions) - they ALL passed.',
        'Your only job is to catch qualitative false positives the thresholds cannot see.',
        '',
        `Fixture: ${fixture}`,
        `League: ${league ?? 'unknown'}`,
        `Kickoff: ${kickoff}`,
        team('Home', home),
        team('Away', away),
        `Head-to-head: ${h2h.n ? `last ${h2h.n} meetings - avg total ${h2h.avgTotal}, over-2.5 rate ${h2h.overRate}` : 'no prior meetings known'}`,
        `Bookmaker prices: over 2.5 = ${market?.over ?? 'n/a'}, under 2.5 = ${market?.under ?? 'n/a'}`
        + ` (vig-removed P(over) = ${market?.impliedOver ?? 'n/a'})`,
        `API-Football prediction: ${api ?? 'no signal'}`,
        '',
        'Veto ONLY when you can name a concrete red flag, for example:',
        '- a scoring average that looks inflated by one anomalous blowout (high avg total',
        '  but a much weaker over-2.5 rate on the same games);',
        '- wildly asymmetric profiles (all the goals come from one side\'s games while the',
        '  other side\'s games are tight and low-scoring);',
        '- the market pricing sharply disagreeing with the statistical picture;',
        '- team news you VERIFIED via web search (key attackers out, heavy rotation,',
        '  a dead-rubber fixture) - only if you can actually browse; NEVER assert',
        '  injuries, rotation or motivation you have not verified.',
        'Do NOT veto because a value sits near its threshold, because the head-to-head',
        'sample is thin or empty (that is neutral by design), because of assumed or',
        'unverified team news, or out of general caution - the shortlist is',
        'intentionally strict already and most candidates deserve confirmation.',
        'Expected veto rate: low.',
        '',
        'Reply with ONLY a JSON object, no other text:',
        '{"verdict":"confirm"|"veto","reason":"one short sentence"}',
    ].join('\n');
    return _adjudicate(prompt);
}

// Human meaning of a canonical tip market key, for the review prompt.
function _tipLabel(market, home, away) {
    const named = {
        1: `${home} to win`,
        X: 'draw',
        2: `${away} to win`,
        '1X': `${home} to win or draw`,
        X2: `${away} to win or draw`,
        12: 'either side to win (no draw)',
    };
    if (named[market]) return named[market];
    const ou = /^([OU]) (\d\.5)$/.exec(market);
    return ou ? `${ou[1] === 'O' ? 'over' : 'under'} ${ou[2]} total goals` : market;
}

// Ask the model to confirm or veto one high-confidence tip given the blend
// breakdown bestTip produced.
//   { fixture, kickoff, league, tip } - tip is the bestTip() return
//   (market/price/confidence/market_prob/stats_prob/api_prob/weights/samples)
export async function reviewTip({ fixture, kickoff, league, tip }) {
    const pct = v => (v == null ? 'n/a' : `${Math.round(v * 100)}%`);
    const [home, away] = String(fixture).split(' - ');
    const prompt = [
        'You are the final reviewer of a shortlist of high-confidence football betting',
        'tips. A deduction engine already picked each tip as the safest bettable outcome',
        'by blending the vig-removed bookmaker probability with rolling-form statistics',
        'and API prediction percentages. Your only job is to catch qualitative false',
        'positives the numbers cannot see.',
        '',
        `Fixture: ${fixture}`,
        `League: ${league ?? 'unknown'}`,
        `Kickoff: ${kickoff}`,
        `Tip: ${tip.market} (${_tipLabel(tip.market, home, away)}) @ ${tip.price}`,
        `Blended confidence: ${pct(tip.confidence)} = market ${pct(tip.market_prob)}`
        + ` (weight ${tip.weights?.market ?? 'n/a'}) + stats ${pct(tip.stats_prob)}`
        + ` (weight ${tip.weights?.stats ?? 'n/a'}) + API ${pct(tip.api_prob)}`
        + ` (weight ${tip.weights?.api ?? 'n/a'})`,
        `Evidence samples: home last ${tip.samples?.home_n ?? '?'} games,`
        + ` away last ${tip.samples?.away_n ?? '?'} games,`
        + ` ${tip.samples?.h2h_n ?? 0} head-to-head meetings`,
        '',
        'Veto ONLY when you can name a concrete red flag, for example:',
        '- the statistical support sharply contradicting the market (a market-driven pick',
        '  the recent form does not back at all);',
        '- team news you VERIFIED via web search (key players injured or suspended, heavy',
        '  squad rotation, a dead-rubber or already-decided tie) - only if you can',
        '  actually browse; NEVER assert injuries, rotation or motivation you have not',
        '  verified.',
        'Before vetoing, check the DIRECTION of your reason: it must argue AGAINST the',
        `tipped outcome. Example: this tip is "${tip.market}"; a factor that makes that`,
        'outcome MORE likely (e.g. weaker scoring when the tip is an under) supports',
        'confirmation, not a veto.',
        'Do NOT veto because the head-to-head sample is thin (neutral by design), because',
        'a value sits near a threshold, because of assumed or unverified team news, or',
        'out of general caution - the shortlist is intentionally strict already and most',
        'tips deserve confirmation. Expected veto rate: low.',
        '',
        'Reply with ONLY a JSON object, no other text:',
        '{"verdict":"confirm"|"veto","reason":"one short sentence"}',
    ].join('\n');
    return _adjudicate(prompt);
}
