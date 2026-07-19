import { effectiveAiConfig } from '../settings.js';
import { Verdict } from '../ai-parse.js';
import { tipMarketLabel } from '../db/magic-rules.js';
import { injectionPreamble, consensusFor } from '../db/ai-guard-rules.js';
import { callStructured, ensembleTag } from './harness.js';
import { aiEnabled } from './gemini.js';

// The hot-pick/tip adjudicators, moved out of gemini.js (T9) so the provider
// module stays transport-only and the import cycle harness -> index ->
// gemini -> adjudicators never forms. Both adjudicators are fail-open (absent
// key or any API failure keeps the rule-based verdict - the features never
// depend on the AI being up), both confirm/veto only (the AI can never
// promote a pick). With HOTPICK_AI_WEB=1 requests attach Gemini's native
// google_search tool, letting verdicts cite real-world context the warehouse
// cannot see (friendlies, injuries, rotation, dead rubbers). Grounded
// requests bill extra per call. (Replaced OpenRouter 2026-07-04.)
//
// THE MIGRATION IS REGIME-NEUTRAL: prompt bytes, model routing (resolveTask
// 'adjudicate' = exactly what _adjudicate hardcoded) and the #p3 reuse tag
// are all unchanged, so nothing re-bills. The only new behavior is the
// harness pipeline around the call (sanitize -> schema -> observe-only
// suspicion flags) and the opt-in run guard.
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

// Convenience re-export: the adjudication callers (hotpicks.js, ai-worker.js)
// import their whole AI surface from this one module.
export { aiEnabled };

// Bumping this re-adjudicates upcoming rows (verdict reuse is keyed on the
// model tag), so material prompt changes take effect without manual resets.
const PROMPT_VERSION = 3;

// T10a (DARK by default): the injection preamble applies to GROUNDED prompts
// only - an ungrounded call retrieves nothing, so there is nothing to guard
// and no reason to perturb its bytes (a bumped tag on an unchanged prompt
// would re-bill for nothing). Reads the EFFECTIVE config (M6): the DARK
// switches and grounding are admin-editable now, and the tag must flip with
// them or reuse would serve stale-regime verdicts.
const _preambleActive = cfg => Boolean(cfg.AI_INJECTION_PREAMBLE && cfg.HOTPICK_AI_WEB);

// Tag stored in ai_model/tip_ai_model - verdict reuse is keyed on it, so
// switching model, grounding, prompt version, the injection preamble (T10a:
// #p3 -> #p4, a prompt-byte change) or a consensus panel (T10b: the ensemble
// replaces the single-model identity) re-adjudicates automatically. The
// ensemble base comes from the harness's OWN ensembleTag so the persisted
// verdict tag and this pending-predicate tag can never drift. `cfg` defaults
// to the effective (admin-override-aware) view; the worker passes its
// per-drain snapshot so tag and prompt can't drift mid-run.
export function aiModelTag(cfg = effectiveAiConfig()) {
    const pv = _preambleActive(cfg) ? PROMPT_VERSION + 1 : PROMPT_VERSION;
    const panel = consensusFor('adjudicate', cfg);
    const base = panel
        ? ensembleTag(panel.models, panel.minAgree)
        : cfg.HOTPICK_AI_MODEL + (cfg.HOTPICK_AI_WEB ? '+search' : '');
    return `${base}#p${pv}`;
}

// Veto margin under the break-even probability: the model's own estimate
// must undercut break-even by at least this much before a veto (its
// estimates are noisy; a hair below break-even is not a red flag).
const VETO_MARGIN = 0.05;

const _breakEven = price => Math.round((1 / Number(price)) * 100) / 100;

// The shared reply contract + verdict rule, parameterized per adjudicator.
// T10a: when the (dark-by-default) injection preamble is active, it prepends
// here - both adjudicator prompts embed _protocol, so one insertion point
// covers them, and aiModelTag()'s #p bump above rides the same predicate.
function _protocol({ outcome, breakEven, cfg }) {
    const floor = Math.round((breakEven - VETO_MARGIN) * 100) / 100;
    return [
        ...(_preambleActive(cfg) ? [...injectionPreamble(), ''] : []),
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
// google_search tool, so the prompt demands JSON and the harness's
// extractJson + Verdict schema decode the reply. Transport retries ride the
// provider's retried complete() (T3); the run guard (opts.guard) is the T9
// addition - a refusal throws and resolves to an 'error' verdict like any
// other failure.
async function _adjudicate(prompt, { guard = null, cfg }) {
    const { data, sources } = await callStructured({ task: 'adjudicate', prompt, schema: Verdict, cfg, guard });
    return {
        verdict: data.verdict,
        reason: data.reason.substring(0, 512),
        model: aiModelTag(cfg),
        review: { probability: data.probability, checks: data.checks, sources },
    };
}

// Independent second opinion on one over-2.5 candidate.
//   { fixture, kickoff, league, home, away, h2h, market, api }
//   home/away: teamGoalsAggregates() results; h2h: h2hGoalsAggregates()
//   opts: { guard, cfg } - see _adjudicate.
export async function adjudicateHotPick({ fixture, kickoff, league, home, away, h2h, market, api }, opts = {}) {
    // ONE cfg for prompt bytes AND tag (M6): resolved here so the preamble
    // the prompt embeds and the #p version the tag carries cannot diverge.
    const cfg = opts.cfg ?? effectiveAiConfig();
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
        ..._protocol({ outcome: 'over 2.5 goals', breakEven, cfg }),
    ].join('\n');
    return _adjudicate(prompt, { ...opts, cfg });
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
//   opts: { guard, cfg } - see _adjudicate.
export async function reviewTip({ fixture, kickoff, league, tip }, opts = {}) {
    const cfg = opts.cfg ?? effectiveAiConfig();
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
        ..._protocol({ outcome: `the tipped outcome: ${label}`, breakEven, cfg }),
    ].join('\n');
    return _adjudicate(prompt, { ...opts, cfg });
}
