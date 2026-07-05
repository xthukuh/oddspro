import { z } from 'zod';

// Pure Gemini reply parsing for the AI adjudicators (v2 structured verdicts).
// Imports zod only - no config/.env - so tests run fully offline, the same
// contract as the src/db/*-rules.js modules. src/ai.js owns the HTTP calls
// and prompts; this module owns everything about decoding what came back.

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
const Verdict = z.object({
    verdict: z.enum(['confirm', 'veto']),
    probability: _prob.optional().transform(v => v ?? null),
    checks: z.record(z.string(), z.string().nullable()).nullish().transform(v => v ?? null),
    reason: z.string().nullish().transform(v => v ?? ''),
});

// Decode one adjudicator reply: envelope -> reply text -> fenced-JSON verdict
// + grounding citations. Throws on anything unusable; callers fail open
// (record 'error', keep the rule verdict).
// Returns { verdict, probability, checks, reason, sources: [{ title, uri }] }.
export function parseAiReply(data) {
    const parsed = GeminiEnvelope.parse(data);
    const candidate = parsed.candidates[0];
    const content = (candidate.content?.parts ?? []).map(p => p.text ?? '').join('');
    const m = /\{[\s\S]*\}/.exec(content); // tolerate markdown code fences
    if (!m) throw new Error(`AI reply carried no JSON object: ${content}`);
    const verdict = Verdict.parse(JSON.parse(m[0]));
    const sources = (candidate.groundingMetadata?.groundingChunks ?? [])
        .map(c => c?.web)
        .filter(w => w && (w.uri || w.title))
        .map(w => ({ title: w.title ?? null, uri: w.uri ?? null }));
    return { ...verdict, sources };
}
