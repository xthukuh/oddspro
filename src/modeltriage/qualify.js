import { z } from 'zod';

// Capability qualification probes for the model-triage add-on: three TINY
// billed calls per candidate, run only for NEW or CHANGED candidates under
// TRIAGE_PROBE_BUDGET. NO oddspro imports (extraction seam) - the actual
// model call is INJECTED by index.js (`call({ model, prompt }) -> { text }`),
// so this module tests offline with a stub and lifts out cleanly.
//
//   json    - strict-JSON contract probe (zod-parsed exact shape+values)
//   reason  - reasoning sanity probe with a known answer
//   latency - exact-echo probe measured against a wall-clock budget; also the
//             canary for the "OpenRouter reply carried no message content"
//             empty-reply failure mode observed live (the injected call
//             throws on it, which records a fail here)

export const PROBES = [
    {
        key: 'json',
        prompt: 'Compute 3+4. Reply with ONLY this JSON object, no other text, no code fences:\n'
            + '{"ok":true,"sum":<the result as a number>}',
    },
    {
        key: 'reason',
        prompt: 'A football match ends 2-1. Reply with ONLY this JSON object, no other text:\n'
            + '{"total":<total goals as a number>,"over25":<true if the total is over 2.5, else false>}',
    },
    {
        key: 'latency',
        prompt: 'Reply with exactly the word OK and nothing else.',
    },
];

// First {...} block in the reply (models love code fences and preambles).
function _jsonBlock(text) {
    const s = String(text ?? '');
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
        return JSON.parse(s.slice(start, end + 1));
    } catch {
        return null;
    }
}

const JsonProbe = z.object({ ok: z.literal(true), sum: z.coerce.number().refine(n => n === 7) });
const ReasonProbe = z.object({ total: z.coerce.number().refine(n => n === 3), over25: z.literal(true) });

// Pure per-probe verdict on the reply TEXT -> { pass, note }.
export function evaluateProbe(key, text) {
    if (key === 'json' || key === 'reason') {
        const obj = _jsonBlock(text);
        if (!obj) return { pass: false, note: 'no parseable JSON in reply' };
        const ok = (key === 'json' ? JsonProbe : ReasonProbe).safeParse(obj).success;
        return ok ? { pass: true, note: null } : { pass: false, note: 'JSON present but contract not met' };
    }
    if (key === 'latency') {
        const s = String(text ?? '').trim();
        return /^["']?ok["']?[.!]?$/i.test(s)
            ? { pass: true, note: null }
            : { pass: false, note: 'did not echo the exact token' };
    }
    return { pass: false, note: `unknown probe ${key}` };
}

// Run all three probes against one model. NEVER rejects: a thrown call
// (transport fault, empty reply, refusal) records that probe as failed and
// the run continues - a flaky candidate is a RESULT, not an error.
export async function runProbes(modelId, { call, maxLatencyMs = 30_000 } = {}) {
    const probes = {};
    for (const probe of PROBES) {
        const t0 = Date.now();
        let verdict;
        try {
            const reply = await call({ model: modelId, prompt: probe.prompt });
            const text = typeof reply === 'string' ? reply : reply?.text;
            verdict = evaluateProbe(probe.key, text);
        } catch (e) {
            verdict = { pass: false, note: String(e?.message ?? e) };
        }
        const ms = Date.now() - t0;
        if (probe.key === 'latency' && verdict.pass && ms > maxLatencyMs) {
            verdict = { pass: false, note: `latency ${ms}ms over the ${maxLatencyMs}ms budget` };
        }
        probes[probe.key] = { pass: verdict.pass, ms, note: verdict.note };
    }
    return {
        model: modelId,
        probes,
        passes: Object.values(probes).filter(p => p.pass).length,
        ranAt: new Date().toISOString(),
    };
}
