// Pure free-model discovery, triage and scoring rules (zero imports so tests
// skip config/.env, the src/db/*-rules.js convention). scripts/model-triage.js
// does the IO - catalog fetch and probe calls through the existing
// src/ai/openrouter.js seam - and asks this module what every reading means.
//
// Why this exists (2026-08-28): model choice here used to be a hand-pick that
// went stale. The free OpenRouter catalog churns (14 slugs in Jul 2026, 21 on
// 2026-08-28), and a slug that answers today can start returning reasoning
// with no content tomorrow - which is exactly the failure that put 8
// reasoning-only and 6 no-choices errors into the live stderr log while
// AI_MAX_TOKENS sat at 3000. A repeatable discover -> probe -> score -> rank
// routine turns that into evidence instead of a guess.
//
// The five acceptance criteria are drawn from failures actually observed on
// this warehouse, not from theory:
//   transport   - the call came back at all
//   content     - it emitted CONTENT, not just a reasoning stream (the bug)
//   json        - the content parses as JSON (every structured caller here
//                 parses the reply as JSON, so a prose-only model is unusable)
//   no_refusal  - it did not decline the betting-domain prompt. oddspro is a
//                 bookmaker odds warehouse; a model that refuses to reason
//                 about a football market cannot serve the adjudicator or the
//                 enrichment tasks at all, however capable it is otherwise
//   latency     - it answered inside the budget

// A model is free when BOTH token prices are zero. OpenRouter reports these
// as decimal strings ('0'), so compare numerically and treat a missing or
// unparseable price as NOT free - a paid model wrongly admitted here would
// silently start billing, which is the one error worth being asymmetric about.
export function isFreeModel(model) {
    const p = Number(model?.pricing?.prompt);
    const c = Number(model?.pricing?.completion);
    return Number.isFinite(p) && Number.isFinite(c) && p === 0 && c === 0;
}

// The vendor prefix of an OpenRouter slug ('z-ai/glm-5.2:free' -> 'z-ai').
// Local rather than imported from db/ai-rules.js so this module stays
// zero-import; the two must agree, and tests pin the shared cases.
export function modelVendor(id) {
    const s = String(id ?? '');
    const i = s.indexOf('/');
    return i > 0 ? s.slice(0, i).toLowerCase() : s.toLowerCase();
}

// Free catalog -> ordered candidate list. `excludeVendors` drops whole
// vendors (oddspro needs this: the blind reasoner must not share a vendor
// with the anchored model, so a candidate FOR anchored must exclude the blind
// vendor). `minContext`/`minOutput` drop models too small to hold a prompt or
// finish a reply. Order is deterministic - by output ceiling then context then
// slug - so two runs over an unchanged catalog rank identically.
export function catalogCandidates(models, { excludeVendors = [], minContext = 0, minOutput = 0 } = {}) {
    const banned = new Set((excludeVendors ?? []).map(v => String(v).toLowerCase()));
    return (Array.isArray(models) ? models : [])
        .filter(isFreeModel)
        .map(m => ({
            id: m.id,
            vendor: modelVendor(m.id),
            context: Number(m.context_length) || 0,
            maxOutput: Number(m.top_provider?.max_completion_tokens) || 0,
        }))
        .filter(c => c.id && !banned.has(c.vendor) && c.context >= minContext && c.maxOutput >= minOutput)
        .sort((a, b) => (b.maxOutput - a.maxOutput) || (b.context - a.context) || a.id.localeCompare(b.id));
}

// Refusal markers. Deliberately phrase-level rather than keyword-level: a
// model reasoning ABOUT a market will legitimately use words like 'gambling'
// or 'betting', so matching those alone would reject every usable model. What
// marks a refusal is the model talking about ITSELF declining.
const REFUSAL_MARKERS = [
    "i can't help", 'i cannot help', "i can't assist", 'i cannot assist',
    "i can't provide", 'i cannot provide', "i won't provide", 'i will not provide',
    "i'm not able to", 'i am not able to', "i'm unable to", 'i am unable to',
    'i must decline', 'i have to decline', 'i do not feel comfortable',
    "i'm sorry, but i", 'i am sorry, but i', 'as an ai', 'against my guidelines',
    'i do not engage with', "i don't engage with",
];

// Whether a reply reads as a refusal, and which marker matched. Case-folded
// substring match over the FIRST 400 characters only: a refusal leads with
// itself, whereas a genuine answer that later quotes a disclaimer must not be
// rejected for it.
export function classifyRefusal(text) {
    const head = String(text ?? '').slice(0, 400).toLowerCase();
    for (const marker of REFUSAL_MARKERS) {
        if (head.includes(marker)) return { refused: true, marker };
    }
    return { refused: false, marker: null };
}

// Pull the first JSON object out of a reply, tolerating the ```json fences
// models add even under a strict-JSON request. Returns null when nothing
// parses - the caller treats that as the `json` criterion failing, never as
// a thrown error.
export function extractJsonObject(text) {
    const s = String(text ?? '').trim();
    const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const body = fenced ? fenced[1].trim() : s;
    const start = body.indexOf('{');
    const end = body.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
        const parsed = JSON.parse(body.slice(start, end + 1));
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

// One probe reading -> the five criteria plus the reason it failed.
// `error`/`replyReason` come from src/ai/openrouter.js's thrown shape, so a
// reasoning-only reply (replyReason 'reasoning-only') is classified as the
// `content` criterion failing rather than as a generic transport error - that
// distinction is the whole point of the exercise.
export function probeVerdict({
    ok = false, text = '', error = null, replyReason = null, ms = 0, requiredKeys = [],
} = {}) {
    const criteria = { transport: false, content: false, json: false, no_refusal: false };
    if (!ok) {
        // 'reasoning-only' and 'truncated' mean the transport worked and the
        // model simply had nothing left to say with - a budget problem, not a
        // dead endpoint. Everything else is a genuine transport failure.
        const budgetShaped = replyReason === 'reasoning-only' || replyReason === 'truncated';
        criteria.transport = budgetShaped;
        return { criteria, pass: false, reason: replyReason ?? (error || 'call failed'), ms: Number(ms) || 0, parsed: null };
    }
    criteria.transport = true;
    const body = String(text ?? '');
    if (!body.trim()) {
        return { criteria, pass: false, reason: 'empty content', ms: Number(ms) || 0, parsed: null };
    }
    criteria.content = true;
    const { refused, marker } = classifyRefusal(body);
    criteria.no_refusal = !refused;
    const parsed = extractJsonObject(body);
    const missing = parsed ? (requiredKeys ?? []).filter(k => !(k in parsed)) : [];
    criteria.json = Boolean(parsed) && missing.length === 0;
    const reason = refused ? `refused (${marker})`
        : !parsed ? 'reply was not JSON'
            : missing.length ? `JSON missing keys: ${missing.join(',')}`
                : 'ok';
    return {
        criteria,
        pass: criteria.transport && criteria.content && criteria.json && criteria.no_refusal,
        reason,
        ms: Number(ms) || 0,
        parsed,
    };
}

// Default criterion weights. `no_refusal` and `json` carry the most because a
// model failing either is unusable here at any speed; latency only ever
// breaks ties between models that already passed.
export const DEFAULT_WEIGHTS = { transport: 1, content: 2, json: 3, no_refusal: 3, latency: 1 };

// Aggregate N probes of ONE model into a score in [0,1] plus its pass rate.
// A model is only `accepted` when EVERY probe passed - a slug that answers
// four times out of five is a slug that will fail in production, and the
// whole point of the ledger is that it does not silently degrade.
export function scoreModel(probes, { weights = DEFAULT_WEIGHTS, latencyBudgetMs = 30_000 } = {}) {
    const runs = Array.isArray(probes) ? probes : [];
    if (!runs.length) return { score: 0, passRate: 0, accepted: false, criteria: {}, medianMs: 0, runs: 0 };
    const keys = ['transport', 'content', 'json', 'no_refusal'];
    const rates = {};
    for (const k of keys) rates[k] = runs.filter(r => r?.criteria?.[k]).length / runs.length;
    const sorted = runs.map(r => Number(r?.ms) || 0).sort((a, b) => a - b);
    const medianMs = sorted[Math.floor(sorted.length / 2)];
    // Latency scores linearly against the budget and never goes negative, so
    // one slow-but-correct model can still outrank a fast broken one.
    const latencyScore = Math.max(0, 1 - (medianMs / Math.max(1, latencyBudgetMs)));
    const total = keys.reduce((s, k) => s + (weights[k] ?? 0), 0) + (weights.latency ?? 0);
    const earned = keys.reduce((s, k) => s + rates[k] * (weights[k] ?? 0), 0) + latencyScore * (weights.latency ?? 0);
    const passRate = runs.filter(r => r?.pass).length / runs.length;
    return {
        score: total > 0 ? earned / total : 0,
        passRate,
        accepted: passRate === 1,
        criteria: rates,
        medianMs,
        runs: runs.length,
    };
}

// Scored models -> the ranked table. Accepted models always outrank rejected
// ones regardless of score, then score, then median latency, then slug for a
// deterministic tie-break.
export function rankModels(scored) {
    return (Array.isArray(scored) ? [...scored] : []).sort((a, b) =>
        (Number(b.accepted) - Number(a.accepted))
        || (b.score - a.score)
        || (a.medianMs - b.medianMs)
        || String(a.id).localeCompare(String(b.id)));
}

// The recommendation for one role, honouring the role's own vendor
// constraint. `excludeVendors` is applied again here (not only at catalog
// time) so a single ranked run can serve several roles with different
// independence rules without re-probing anything.
export function recommendForRole(ranked, { excludeVendors = [] } = {}) {
    const banned = new Set((excludeVendors ?? []).map(v => String(v).toLowerCase()));
    return (Array.isArray(ranked) ? ranked : [])
        .find(m => m.accepted && !banned.has(modelVendor(m.id))) ?? null;
}
