import { z } from 'zod';

// Pure Gemini reply parsing for the AI adjudicators (v2 structured verdicts).
// Imports zod only - no config/.env - so tests run fully offline, the same
// contract as the src/db/*-rules.js modules. src/ai/gemini.js owns the HTTP
// calls and prompts; this module owns everything about decoding what came back.

// Gemini generateContent response envelope (validated - external data).
// Tolerant on purpose: grounded replies may split text across parts,
// safety-blocked candidates can arrive without content at all, and
// groundingMetadata only exists when the google_search tool actually ran.
export const GeminiEnvelope = z.object({
    candidates: z.array(z.object({
        content: z.object({
            parts: z.array(z.object({ text: z.string().optional() })).nullable().optional(),
        }).nullable().optional(),
        groundingMetadata: z.object({
            groundingChunks: z.array(z.object({
                web: z.object({
                    uri: z.string().nullable().optional(),
                    title: z.string().nullable().optional(),
                }).nullable().optional(),
            })).nullable().optional(),
        }).nullable().optional(),
    })).min(1),
});

// Models love replying with percentages despite the 0..1 contract; normalize
// 65 -> 0.65 instead of discarding an otherwise good verdict (a discarded
// verdict is stored as 'error' and re-bills on the next run).
const _prob = z.preprocess(v => {
    if (v == null) return null;
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    return n > 1 && n <= 100 ? n / 100 : n;
}, z.number().min(0).max(1).nullable());

// v2 structured verdict. Only `verdict` is load-bearing; probability, checks
// and reason tolerate omission (Gemini sometimes trims fields on confirms).
// Exported (T9) so the harness path (src/ai/adjudicators.js via
// callStructured) applies the SAME schema parseVerdict does - one contract,
// two entry points, no drift.
export const Verdict = z.object({
    verdict: z.enum(['confirm', 'veto']),
    probability: _prob.optional().transform(v => v ?? null),
    checks: z.record(z.string(), z.string().nullable()).nullish().transform(v => v ?? null),
    reason: z.string().nullish().transform(v => v ?? ''),
});

// Envelope -> { text, sources }. The verdict-shaped sibling of parseAiReply,
// for callers that apply their own per-kind schema (M4.1 enrichment).
export function extractGeminiText(data) {
    const parsed = GeminiEnvelope.parse(data);
    const candidate = parsed.candidates[0];
    const text = (candidate.content?.parts ?? []).map(p => p.text ?? '').join('');
    const sources = (candidate.groundingMetadata?.groundingChunks ?? [])
        .map(c => c?.web)
        .filter(w => w && (w.uri || w.title))
        .map(w => ({ title: w.title ?? null, uri: w.uri ?? null }));
    return { text, sources };
}

// Every BALANCED top-level {...} span in a reply, in the order they appear.
// Brace counting is string-aware (a brace inside a JSON string value, and an
// escaped quote inside it, must not move the depth), which a regex cannot do.
// Unterminated spans are dropped: a reply the model cut mid-object yields no
// candidate rather than a fragment.
function objectSpans(text) {
    const spans = [];
    const open = [];
    let inString = false, escaped = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (inString) {
            if (escaped) escaped = false;
            else if (ch === '\\') escaped = true;
            else if (ch === '"') inString = false;
            continue;
        }
        if (ch === '"') inString = true;
        else if (ch === '{') open.push(i);
        else if (ch === '}' && open.length) spans.push(text.slice(open.pop(), i + 1));
    }
    // Emitted when each pair CLOSES, so an object always follows the children
    // nested inside it, and a stray unclosed brace in prose (`... shape { ...`)
    // cannot swallow the object that follows it.
    return spans;
}

// The reply's JSON object, parsed. Tolerates markdown fences, a prose preamble
// (including one containing braces, e.g. a model restating the schema before
// answering), and trailing commentary.
//
// Until 2026-08-19 this was a greedy `/\{[\s\S]*\}/`, which spans from the
// FIRST brace anywhere in the reply to the LAST one. A grounded adjudicator
// reply that mentioned a brace before its JSON therefore produced one
// unparseable blob, and live logged a stream of "Expected ',' or '}' after
// property value" failures with every verdict silently dropped. Candidates are
// now tried LAST-first, because a model that restates the schema and then
// answers puts the real answer last.
// Throws when nothing parses - callers fail open.
export function extractJson(text) {
    const raw = String(text);
    const spans = objectSpans(raw);
    if (!spans.length) throw new Error(`AI reply carried no JSON object: ${raw}`);
    let lastError = null;
    for (let i = spans.length - 1; i >= 0; i--) {
        try {
            return JSON.parse(spans[i]);
        } catch (e) {
            lastError = e;
        }
    }
    // The reply is quoted (bounded) because this error is the only place the
    // offending text is ever visible: the worker fails open and keeps nothing.
    throw new Error(`AI reply carried no parseable JSON object (${lastError?.message ?? 'unknown'}): ${raw.slice(0, 400)}`);
}

// One OpenAI-compatible `choices[0]` -> a decision about whether it carried a
// usable reply, and if not, WHICH way it failed. Pure and total.
//
// The live pipeline log (2026-08-19 .. 2026-08-22) reported these as two
// unrelated errors - 30 x "carried no message content" and 4 x "truncated at
// the model's token limit (0 chars)" - but they are ONE root cause: every
// enrichment model in the current roster is a reasoning model, no max_tokens
// was ever sent, and the reasoning stream can consume the whole completion
// budget before a single content token is emitted. Whether the provider then
// reports finish_reason 'length' or 'stop' is provider detail, not a different
// problem, so both resolve to `retryable: true` and one retry policy covers
// them (src/ai/index.js retries once with a raised ceiling and lower
// reasoning effort).
//
// Returns { ok, retryable, reason, text, finishReason, reasoningChars, message }.
//   reason: 'ok' | 'no-choice' | 'truncated' | 'reasoning-only' | 'empty'
export function chatReplyOutcome(choice) {
    const base = { ok: false, retryable: false, reason: 'no-choice', text: '', finishReason: null, reasoningChars: 0 };
    if (!choice || typeof choice !== 'object') {
        return { ...base, message: 'OpenRouter reply carried no choices' };
    }
    const message = choice.message;
    const finishReason = typeof choice.finish_reason === 'string' ? choice.finish_reason : null;
    if (!message || typeof message !== 'object') {
        return { ...base, finishReason, message: 'OpenRouter reply carried no message object' };
    }
    const text = typeof message.content === 'string' ? message.content : '';
    const reasoningChars = typeof message.reasoning === 'string' ? message.reasoning.length : 0;
    const blank = !text.trim();

    // finish_reason 'length' means the ceiling cut the reply. Even when some
    // content arrived it is a JSON object cut mid-value, so extractJson would
    // fail with a confusing syntax error at whatever character it stopped on -
    // say "truncated" instead, and let the caller retry with more room.
    if (finishReason === 'length') {
        const reason = blank && reasoningChars > 0 ? 'reasoning-only' : 'truncated';
        const detail = `${text.length} content chars, ${reasoningChars} reasoning chars`;
        return {
            ok: false, retryable: true, reason, text, finishReason, reasoningChars,
            message: reason === 'reasoning-only'
                ? `OpenRouter reply spent its whole token budget on reasoning and emitted no content (${detail})`
                : `OpenRouter reply was truncated at the model's token limit (${detail})`,
        };
    }
    if (blank) {
        const reason = reasoningChars > 0 ? 'reasoning-only' : 'empty';
        return {
            ok: false, retryable: true, reason, text, finishReason, reasoningChars,
            message: reason === 'reasoning-only'
                ? `OpenRouter reply carried reasoning but no message content (${reasoningChars} reasoning chars)`
                : 'OpenRouter reply carried no message content',
        };
    }
    return { ok: true, retryable: false, reason: 'ok', text, finishReason, reasoningChars, message: '' };
}

// Text-level verdict decode: raw reply text -> fenced-JSON verdict (T3
// split). Provider-agnostic - callers that already hold reply text (the
// AI-review worker via the retried complete(), later the harness) decode
// here without pretending their reply came in a Gemini envelope. Throws on
// anything unusable; callers fail open.
export function parseVerdict(text) {
    return Verdict.parse(extractJson(text));
}

// Decode one adjudicator reply: envelope -> reply text -> fenced-JSON verdict
// + grounding citations. Throws on anything unusable; callers fail open
// (record 'error', keep the rule verdict).
// Returns { verdict, probability, checks, reason, sources: [{ title, uri }] }.
export function parseAiReply(data) {
    const { text, sources } = extractGeminiText(data);
    return { ...parseVerdict(text), sources };
}
