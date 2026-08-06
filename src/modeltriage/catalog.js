import { z } from 'zod';
import { withRetry } from '../db/retry-rules.js';
import { isRetryableNetworkError } from '../db/net-rules.js';

// OpenRouter catalog client for the model-triage add-on. NO oddspro imports
// beyond the shared retry helpers (the extraction seam - index.js passes the
// base URL in). Both endpoints are FREE and unauthenticated:
//   GET /api/v1/models                       - pricing, context,
//       supported_parameters, created, Artificial-Analysis benchmark indices
//   GET /api/v1/models/{author}/{slug}/endpoints - per-endpoint uptime/latency
// The models-API diff IS the announcement ground truth (no RSS exists), so a
// tolerant parse matters more than a strict one: a junk row is dropped, never
// a sweep-aborting throw (the apisports schema-tolerance lesson).

const RETRY = { tries: 3, base: 500, isRetryable: isRetryableNetworkError };

// A pricing figure arrives as a per-token USD STRING ('0.00000125'); junk or
// absent -> null so downstream cost math reads it as 0 via ?? 0.
const _num = z.preprocess(v => {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}, z.number().nullable());

const RawModel = z.object({
    id: z.string().min(1),
    name: z.string().nullish(),
    created: _num.optional(),
    context_length: _num.optional(),
    pricing: z.object({
        prompt: _num.optional(),
        completion: _num.optional(),
        web_search: _num.optional(),
    }).nullish(),
    supported_parameters: z.array(z.string()).nullish(),
}).passthrough();

// The AA intelligence index has moved between response shapes; probe every
// path seen in the wild and take the first finite one.
function _aaIndex(raw) {
    const candidates = [
        raw?.benchmarks?.artificial_analysis?.intelligence_index,
        raw?.benchmarks?.aa_intelligence_index,
        raw?.artificial_analysis?.intelligence_index,
        raw?.aa_intelligence_index,
    ];
    for (const c of candidates) {
        const n = Number(c);
        if (c != null && Number.isFinite(n)) return n;
    }
    return null;
}

// One raw API row -> the normalized shape score.js consumes, or null for a
// row that cannot be used (no id). Never throws.
export function normalizeModel(raw) {
    const parsed = RawModel.safeParse(raw);
    if (!parsed.success) return null;
    const m = parsed.data;
    const params = m.supported_parameters ?? [];
    const pricing = {
        prompt: m.pricing?.prompt ?? null,
        completion: m.pricing?.completion ?? null,
        web_search: m.pricing?.web_search ?? null,
    };
    const slash = m.id.indexOf('/');
    return {
        id: m.id,
        name: m.name ?? m.id,
        vendor: (slash > 0 ? m.id.slice(0, slash) : m.id).toLowerCase(),
        created: m.created ?? null,
        context: m.context_length ?? null,
        pricing,
        structured: params.includes('structured_outputs') || params.includes('response_format'),
        tools: params.includes('tools'),
        free: m.id.endsWith(':free')
            || (pricing.prompt != null && Number(pricing.prompt) === 0
                && pricing.completion != null && Number(pricing.completion) === 0),
        aa: _aaIndex(raw),
    };
}

// Whole /api/v1/models reply -> normalized array (junk rows dropped).
export function parseCatalog(json) {
    const data = json?.data;
    if (!Array.isArray(data)) return [];
    return data.map(normalizeModel).filter(Boolean);
}

// /models/{id}/endpoints reply -> { uptime } (the BEST endpoint's
// uptime_last_30m - OpenRouter routes to healthy endpoints first, so the best
// one is what a call would actually hit) or null when nothing is known.
export function parseEndpoints(json) {
    const eps = json?.data?.endpoints;
    if (!Array.isArray(eps) || !eps.length) return null;
    const ups = eps.map(e => Number(e?.uptime_last_30m)).filter(Number.isFinite);
    if (!ups.length) return null;
    return { uptime: Math.max(...ups) };
}

async function _getJson(url, fetchImpl) {
    return withRetry(async () => {
        const res = await fetchImpl(url, { signal: AbortSignal.timeout(30_000) });
        if (!res.ok) throw new Error(`OpenRouter catalog HTTP ${res.status} for ${url}`);
        return res.json();
    }, RETRY);
}

export async function fetchCatalog({ baseUrl = 'https://openrouter.ai/api/v1', fetchImpl = fetch } = {}) {
    return parseCatalog(await _getJson(`${baseUrl}/models`, fetchImpl));
}

// Best-effort per-model endpoint health; null on ANY failure (the uptime gate
// treats null as unknown, and the probe verdicts are the gate that bites).
export async function fetchEndpoints(id, { baseUrl = 'https://openrouter.ai/api/v1', fetchImpl = fetch } = {}) {
    try {
        return parseEndpoints(await _getJson(`${baseUrl}/models/${id}/endpoints`, fetchImpl));
    } catch {
        return null;
    }
}
