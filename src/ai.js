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
//   { fixture, kickoff, league, signals, market, api }
export async function adjudicateHotPick({ fixture, kickoff, league, signals, market, api }) {
    const lines = signals.map(s =>
        `- ${s.key}: ${s.value ?? 'n/a'} (threshold ${s.threshold}, ${s.pass ? 'PASS' : 'FAIL'})`);
    const prompt = [
        'You are a strict football goals analyst. A rule engine flagged this fixture as a',
        'candidate for OVER 2.5 total goals. Your job is to catch false positives, not to',
        'be agreeable - veto whenever the evidence looks fragile, contradictory or stale.',
        '',
        `Fixture: ${fixture}`,
        `League: ${league ?? 'unknown'}`,
        `Kickoff: ${kickoff}`,
        `Bookmaker prices: over 2.5 = ${market?.over ?? 'n/a'}, under 2.5 = ${market?.under ?? 'n/a'}`
        + ` (vig-removed P(over) = ${market?.impliedOver ?? 'n/a'})`,
        `API-Football prediction signal: ${api ?? 'none'}`,
        'Rule signals:',
        ...lines,
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
