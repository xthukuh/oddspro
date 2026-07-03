import axios from 'axios';
import { z } from 'zod';
import { config } from './config.js';

// Optional OpenRouter adjudicator for hot picks: a last confirm/veto gate run
// ONLY on candidates that already passed every deduction rule (a handful of
// calls per day at most). Absent key or any API failure keeps the rule-based
// verdict (fail-open) - the feature never depends on the AI being up.

export function aiEnabled() {
    return Boolean(config.OPENROUTER_API_KEY);
}

// OpenRouter response envelope (validated - external data)
const ChatEnvelope = z.object({
    choices: z.array(z.object({
        message: z.object({ content: z.string() }),
    })).min(1),
});

const Verdict = z.object({
    verdict: z.enum(['confirm', 'veto']),
    reason: z.string(),
});

// Extract the reply's JSON object, tolerating markdown code fences.
function _parseVerdict(content) {
    const m = /\{[\s\S]*\}/.exec(content);
    if (!m) throw new Error(`AI reply carried no JSON object: ${content}`);
    return Verdict.parse(JSON.parse(m[0]));
}

// Ask the model to confirm or veto one over-2.5 candidate given the full
// signal breakdown. Throws on any failure; the caller records ai_verdict
// 'error' and keeps the rule verdict.
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
        '- the market pricing sharply disagreeing with the statistical picture.',
        'Do NOT veto because a value sits near its threshold, because the head-to-head',
        'sample is thin or empty (that is neutral by design), or out of general caution -',
        'the shortlist is intentionally strict already and most candidates deserve',
        'confirmation. Expected veto rate: low.',
        '',
        'Reply with ONLY a JSON object, no other text:',
        '{"verdict":"confirm"|"veto","reason":"one short sentence"}',
    ].join('\n');

    const res = await axios.post(`${config.OPENROUTER_URL}/chat/completions`, {
        model: config.HOTPICK_AI_MODEL,
        temperature: 0,
        messages: [{ role: 'user', content: prompt }],
    }, {
        headers: {
            Authorization: `Bearer ${config.OPENROUTER_API_KEY}`,
            'Content-Type': 'application/json',
        },
        timeout: 30_000,
    });
    const parsed = ChatEnvelope.parse(res.data);
    const out = _parseVerdict(parsed.choices[0].message.content);
    return { ...out, reason: out.reason.substring(0, 512), model: config.HOTPICK_AI_MODEL };
}
