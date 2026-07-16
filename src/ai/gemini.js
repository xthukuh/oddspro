import axios from 'axios';
import { config } from '../config.js';
import { parseVerdict, extractGeminiText } from '../ai-parse.js';
import { tipMarketLabel } from '../db/magic-rules.js';
import { withRetry } from '../db/retry-rules.js';
import { isRetryableNetworkError } from '../db/net-rules.js';

// Optional Google Gemini adjudicators, both fail-open (absent key or any API
// failure keeps the rule-based verdict - the features never depend on the AI
// being up), both confirm/veto only (the AI can never promote a pick):
// - adjudicateHotPick: independent second opinion on over-2.5 candidates
//   that passed every deduction rule (a handful of calls per day at most);
// - reviewTip: same idea for the top-confidence tips (capped per run).
// With HOTPICK_AI_WEB=1 requests attach Gemini's native google_search tool,
// letting verdicts cite real-world context the warehouse cannot see
// (friendlies, injuries, rotation, dead rubbers). Grounded requests bill
// extra per call. (Replaced OpenRouter 2026-07-04.)
//
// Prompt v2 (2026-07-05, tag suffix #p2): the v1 prompts anchored toward
// confirmation ("they ALL passed... expected veto rate: low") and every
// settled v1 hot veto was a market-vs-stats contradiction re-litigating the
// rule engine's own numbers - net-negative (4 winners killed vs 1 loser).
// v2 verdicts are research-driven instead: verify context and team news,
// state an INDEPENDENT probability, then veto mechanically only when that
// probability falls below the price's break-even (minus a margin) or a
// verified concrete disqualifier exists. Numeric contradiction alone is
// explicitly not a veto ground. Replies are structured (probability,
// per-check findings, grounding citations) and persisted to the ai_review /
// tip_ai_review JSON columns for the web popover.
//
// Prompt v3 (M3, tag suffix #p3): reviewTip's tip label now falls back to
// the shared tipMarketLabel glossary (magic-rules) for M3's new-family
// markets (BTTS/DNB/odd-even/team-totals), which the old fixture-aware
// _tipLabel dictionary didn't cover - without this the reviewer saw a bare,
// meaningless "DNB1 (DNB1)" for those tips instead of an actual description.

// Bumping this re-adjudicates upcoming rows (verdict reuse is keyed on the
// model tag), so material prompt changes take effect without manual resets.
const PROMPT_VERSION = 3;

export function aiEnabled() {
    return Boolean(config.GEMINI_API_KEY);
}

// Alias matching the provider-seam interface openrouter.js already exposes
// (M4.1 final review finding 4: `openrouter.enabled()` had zero callers -
// dead code, and there was no symmetric Gemini check a caller COULD route
// through). src/enrich.js's preflight calls getProvider(name).enabled() for
// BOTH providers uniformly instead of reaching into each module's own
// differently-named check; aiEnabled() itself stays as the name every
// existing hotpicks.js/ai/index.js call site already expects.
export const enabled = aiEnabled;

// Tag stored in ai_model/tip_ai_model - verdict reuse is keyed on it, so
// switching model, grounding or prompt version re-adjudicates automatically.
export function aiModelTag() {
    return config.HOTPICK_AI_MODEL
        + (config.HOTPICK_AI_WEB ? '+search' : '')
        + `#p${PROMPT_VERSION}`;
}

// Veto margin under the break-even probability: the model's own estimate
// must undercut break-even by at least this much before a veto (its
// estimates are noisy; a hair below break-even is not a red flag).
const VETO_MARGIN = 0.05;

const _breakEven = price => Math.round((1 / Number(price)) * 100) / 100;

// The shared reply contract + verdict rule, parameterized per adjudicator.
function _protocol({ outcome, breakEven }) {
    const floor = Math.round((breakEven - VETO_MARGIN) * 100) / 100;
    return [
        'Review protocol - work through these steps in order:',
        '1. CONTEXT - what kind of match is this really? Preseason or club friendly,',
        '   youth/reserve sides, a cup dead rubber, end-of-season nothing-at-stake,',
        '   severe weather, a neutral venue. If you can use web search, verify and',
        '   summarize in checks.context. NEVER assert context you have not verified.',
        '2. TEAM NEWS - verified injuries, suspensions, confirmed heavy rotation.',
        '   Only from sources you actually consulted; otherwise write "not verified".',
        '   Summarize in checks.team_news.',
        `3. YOUR OWN PROBABILITY - estimate P(${outcome}) yourself from the facts`,
        '   above plus anything verified in steps 1-2, BEFORE weighing the bookmaker',
        '   price. Record it as `probability`; note the market comparison in',
        '   checks.market.',
        '',
        'Verdict rule - apply it mechanically to your own estimate:',
        `- veto when your probability is below ${floor} (break-even ${breakEven}`,
        `  minus a ${VETO_MARGIN} noise margin), OR you verified a concrete`,
        '  disqualifier in steps 1-2.',
        '- confirm otherwise.',
        '- A gap between the market price and the statistical form alone is NEVER a',
        '  veto ground: the rule engine already weighed those same numbers. Your',
        '  value is what the numbers cannot see.',
        '',
        'Reply with ONLY a JSON object, no other text:',
        '{"verdict":"confirm"|"veto","probability":0.0-1.0,',
        ' "checks":{"context":"...","team_news":"...","market":"..."},',
        ' "reason":"one short sentence naming the decisive factor"}',
    ];
}

// One verdict round-trip: prompt in, { verdict, reason, model, review } out
// (review = { probability, checks, sources } - persisted as JSON).
// Throws on any failure; callers record ai_verdict 'error' and keep the rule
// verdict (fail-open). No JSON response mode - it can't be combined with the
// google_search tool, so the prompt demands JSON and parseVerdict extracts.
// Rides the retried complete() (T3): transient transport errors self-heal
// exactly like the enrichment calls; a bad reply is a model problem and is
// never retried (isRetryableNetworkError excludes anything with a response).
async function _adjudicate(prompt) {
    const { text, sources } = await complete({
        model: config.HOTPICK_AI_MODEL,
        prompt,
        grounded: Boolean(config.HOTPICK_AI_WEB),
    });
    const { verdict, probability, checks, reason } = parseVerdict(text);
    return {
        verdict,
        reason: reason.substring(0, 512),
        model: aiModelTag(),
        review: { probability, checks, sources },
    };
}

// Generic single completion for the M4.1 enrichment layer. Returns raw text +
// grounding citations; the caller applies its own per-kind zod schema.
// Throws on any failure - callers fail open, exactly like the adjudicators.
const RETRY = { tries: 3, base: 500, isRetryable: isRetryableNetworkError };

export async function complete({ model, prompt, grounded }) {
    const res = await withRetry(() => axios.post(
        `${config.GEMINI_URL}/models/${model}:generateContent`,
        {
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0 },
            ...(grounded ? { tools: [{ google_search: {} }] } : {}),
        },
        {
            headers: { 'x-goog-api-key': config.GEMINI_API_KEY, 'Content-Type': 'application/json' },
            timeout: 60_000, // grounded calls run searches before answering
        },
    ), RETRY);
    return extractGeminiText(res.data);
}

// Independent second opinion on one over-2.5 candidate.
//   { fixture, kickoff, league, home, away, h2h, market, api }
//   home/away: teamGoalsAggregates() results; h2h: h2hGoalsAggregates()
export async function adjudicateHotPick({ fixture, kickoff, league, home, away, h2h, market, api }) {
    const team = (label, t) =>
        `${label}: last ${t.n} games - avg total ${t.avgTotal}, over-2.5 rate ${t.overRate},`
        + ` scored ${t.gfAvg}/game, conceded ${t.gaAvg}/game, both-teams-scored rate ${t.bttsRate}`;
    const breakEven = market?.over ? _breakEven(market.over) : 0.5;
    const prompt = [
        'You are an independent reviewer giving a second opinion on one candidate',
        'football bet: OVER 2.5 total goals in the fixture below. A rule engine',
        'selected it from quantitative form data alone. Do NOT assume the selection',
        'is correct and do NOT re-check its arithmetic - judge the bet on your own',
        'analysis of things the numbers cannot see.',
        '',
        `Fixture: ${fixture}`,
        `League: ${league ?? 'unknown'}`,
        `Kickoff: ${kickoff}`,
        team('Home', home),
        team('Away', away),
        `Head-to-head: ${h2h.n ? `last ${h2h.n} meetings - avg total ${h2h.avgTotal}, over-2.5 rate ${h2h.overRate}` : 'no prior meetings known'}`,
        `Bookmaker prices: over 2.5 = ${market?.over ?? 'n/a'}, under 2.5 = ${market?.under ?? 'n/a'}`
        + ` (vig-removed P(over) = ${market?.impliedOver ?? 'n/a'}; break-even P = ${breakEven})`,
        `API-Football prediction: ${api ?? 'no signal'}`,
        '',
        ..._protocol({ outcome: 'over 2.5 goals', breakEven }),
    ].join('\n');
    return _adjudicate(prompt);
}

// Human meaning of a canonical tip market key, for the review prompt. Result
// markets get fixture-specific team-named phrasing; everything else
// (including M3's new-family markets - BTTS/DNB/odd-even/team-totals, which
// this dictionary has no team-aware phrasing for) falls back to the shared
// plain-language glossary (tipMarketLabel, magic-rules) so `tip.market`
// always renders beside an actual description, never the bare key twice.
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
    if (ou) return `${ou[1] === 'O' ? 'over' : 'under'} ${ou[2]} total goals`;
    return tipMarketLabel(market);
}

// Independent second opinion on one high-confidence tip. The prompt gives
// the raw evidence (market probability, rolling-form support, samples) but
// deliberately NOT our blended confidence - the reviewer must not anchor on
// the score it is meant to check.
//   { fixture, kickoff, league, tip } - tip is the bestTip() return
export async function reviewTip({ fixture, kickoff, league, tip }) {
    const pct = v => (v == null ? 'n/a' : `${Math.round(v * 100)}%`);
    const [home, away] = String(fixture).split(' - ');
    const label = _tipLabel(tip.market, home, away);
    const breakEven = _breakEven(tip.price);
    const prompt = [
        'You are an independent reviewer giving a second opinion on one candidate',
        'football bet (the "tip" below). A deduction engine selected it from odds',
        'and quantitative form data alone. Do NOT assume the selection is correct',
        'and do NOT re-check its arithmetic - judge the bet on your own analysis of',
        'things the numbers cannot see.',
        '',
        `Fixture: ${fixture}`,
        `League: ${league ?? 'unknown'}`,
        `Kickoff: ${kickoff}`,
        `Tip: ${tip.market} (${label}) @ ${tip.price} (break-even P = ${breakEven})`,
        `Evidence for the tipped outcome: vig-removed market P = ${pct(tip.market_prob)};`
        + ` rolling-form support = ${pct(tip.stats_prob)} over the last`
        + ` ${tip.samples?.home_n ?? '?'} (home) / ${tip.samples?.away_n ?? '?'} (away) games`
        + ` and ${tip.samples?.h2h_n ?? 0} head-to-head meetings;`
        + ` API-Football estimate = ${pct(tip.api_prob)}`,
        '',
        'Before any veto, check DIRECTION: your reason must argue AGAINST the tipped',
        `outcome ("${label}"). A factor that makes that outcome MORE likely supports`,
        'confirmation, not a veto.',
        '',
        ..._protocol({ outcome: `the tipped outcome: ${label}`, breakEven }),
    ].join('\n');
    return _adjudicate(prompt);
}
