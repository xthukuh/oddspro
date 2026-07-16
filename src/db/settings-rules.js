// Pure dynamic-settings rules (zod-only, offline-testable). Defines the CURATED
// catalog of operational knobs an admin may override at runtime, and the
// coerce/validate/merge helpers. Everything NOT in the catalog (secrets, DB
// creds, VITE_* build vars, host/port) is off-limits by construction. The
// service layer (src/settings.js) reads overrides late (like magic.js#safePolicy)
// and merges them over the immutable config defaults.
//
// Per-entry flags:
//   public - shipped to the browser via GET /api/settings (NEVER a secret)
//   live   - an override takes effect without a server restart (its consumer
//            late-reads via settings.effective); live:false needs a restart
//            (read once at boot / middleware registration / scheduler start).

import { z } from 'zod';

// PUT /api/admin/settings body envelope (C2 - external data through zod like
// the sibling auth routes): either { key, value } or { overrides: {...} }.
// Values stay z.unknown() - the real per-key validation is validateSettings
// against the catalog below; this schema only pins the request shape.
export const settingsPutSchema = z.object({
    key: z.string().min(1).optional(),
    value: z.unknown().optional(),
    overrides: z.record(z.unknown()).optional(),
}).refine(d => d.overrides != null || d.key != null, { message: 'Provide { key, value } or { overrides }' });

export const SETTINGS_CATALOG = [
    // Safe-only slip selection - already late-read by magic.js#safePolicy and
    // shipped to the client, so these are public + live.
    { key: 'SAFE_STRATEGY', type: 'string', group: 'safe', public: true, live: true },
    { key: 'SAFE_MIN_PARTS', type: 'int', group: 'safe', public: true, live: true, min: 1, max: 3 },
    { key: 'SAFE_MIN_AGREEMENT', type: 'number', group: 'safe', public: true, live: true, min: 0, max: 1 },
    { key: 'SAFE_MAX_PRICE', type: 'number', group: 'safe', public: true, live: true, min: 1 },
    { key: 'SAFE_MAX_PER_DAY', type: 'int', group: 'safe', public: true, live: true, min: 1 },
    { key: 'SAFE_MIN_SAMPLES', type: 'int', group: 'safe', public: true, live: true, min: 0 },
    { key: 'SAFE_MIN_H2H', type: 'int', group: 'safe', public: true, live: true, min: 0 },
    { key: 'SAFE_MIN_MARKET_SETTLED', type: 'int', group: 'safe', public: true, live: true, min: 0 },
    // Refresh cadence / cooldowns - late-read at call time / per tick, so live.
    { key: 'REFRESH_COOLDOWN_MINUTES', type: 'number', group: 'refresh', public: false, live: true, min: 0 },
    { key: 'REFRESH_CACHE_MINUTES', type: 'number', group: 'refresh', public: false, live: true, min: 0 },
    { key: 'AUTO_LIGHT_MINUTES', type: 'int', group: 'refresh', public: false, live: true, min: 0 },
    { key: 'AUTO_FULL_DAYS', type: 'int', group: 'refresh', public: false, live: true, min: 0 },
    // Read once when the scheduler starts -> restart required.
    { key: 'AUTO_REFRESH_ENABLED', type: 'boolean', group: 'refresh', public: false, live: false },
    { key: 'AUTO_FULL_AT', type: 'string', group: 'refresh', public: false, live: false },
    // Feature flags. SMS + bot-UA are late-read per send/request (sms/index.js
    // smsEnabled, the server's bot-UA middleware) -> live. Geo is read once at
    // scheduler start (geo.js startGeoScheduler) -> restart required.
    { key: 'SMS_ENABLED', type: 'boolean', group: 'features', public: false, live: true },
    { key: 'BOT_UA_FILTER_ENABLED', type: 'boolean', group: 'features', public: false, live: true },
    { key: 'GEO_RESOLVE_ENABLED', type: 'boolean', group: 'features', public: false, live: false },
    // M4.1 AI enrichment (collection only - nothing feeds ranking). All late-read
    // per run (src/enrich.js et al, Task 3+) -> live. OPENROUTER_API_KEY is a
    // secret and stays OUT of this catalog by construction (config.js only).
    { key: 'AI_ENRICH_ENABLED', type: 'boolean', group: 'ai', public: false, live: true },
    { key: 'AI_ENRICH_CAP', type: 'int', group: 'ai', public: false, live: true, min: 0, max: 2000 },
    { key: 'AI_ENRICH_CONCURRENCY', type: 'int', group: 'ai', public: false, live: true, min: 1, max: 16 },
    { key: 'OPENROUTER_MODEL', type: 'string', group: 'ai', public: false, live: true },
    { key: 'AI_BLIND_MODEL', type: 'string', group: 'ai', public: false, live: true },
    { key: 'AI_ANCHORED_MODEL', type: 'string', group: 'ai', public: false, live: true },
];

const BY_KEY = new Map(SETTINGS_CATALOG.map(e => [e.key, e]));
export function catalogEntry(key, catalog = SETTINGS_CATALOG) {
    return catalog === SETTINGS_CATALOG ? (BY_KEY.get(key) ?? null) : (catalog.find(e => e.key === key) ?? null);
}

// Coerce a stored string value to the catalog type. Booleans use the SAME
// explicit truthy set as config.js (never z.coerce.boolean - "0" would be true).
export function coerceValue(type, raw) {
    if (raw == null) return raw;
    switch (type) {
        // 'int' coerces with plain Number so a non-integer stays non-integer for
        // validateSetting to REJECT (truncating would silently accept "2.5").
        case 'int':
        case 'number': return Number(raw);
        case 'boolean': return ['1', 'true', 'yes'].includes(String(raw).toLowerCase());
        default: return String(raw);
    }
}

// Validate a proposed override -> { ok, value } | { ok:false, error }.
export function validateSetting(key, raw, catalog = SETTINGS_CATALOG) {
    const e = catalogEntry(key, catalog);
    if (!e) return { ok: false, error: `Unknown or non-editable setting: ${key}` };
    const value = coerceValue(e.type, raw);
    if (e.type === 'int' || e.type === 'number') {
        if (!Number.isFinite(value)) return { ok: false, error: `${key} must be a number` };
        if (e.type === 'int' && !Number.isInteger(value)) return { ok: false, error: `${key} must be a whole number` };
        if (e.min != null && value < e.min) return { ok: false, error: `${key} must be >= ${e.min}` };
        if (e.max != null && value > e.max) return { ok: false, error: `${key} must be <= ${e.max}` };
    }
    if (e.enum && !e.enum.includes(value)) return { ok: false, error: `${key} must be one of: ${e.enum.join(', ')}` };
    return { ok: true, value };
}

// Batch-validate [key, raw] entries - ALL must pass before ANY is applied
// (all-or-nothing, M7). Collects every error so the admin fixes the batch in
// one round-trip instead of discovering failures one 400 at a time.
export function validateSettings(entries, catalog = SETTINGS_CATALOG) {
    if (!Array.isArray(entries) || !entries.length) {
        return { ok: false, errors: ['No settings provided'] };
    }
    const values = [];
    const errors = [];
    for (const [key, raw] of entries) {
        const v = validateSetting(key, raw, catalog);
        if (v.ok) values.push({ key, value: v.value });
        else errors.push(v.error);
    }
    return errors.length ? { ok: false, errors } : { ok: true, values };
}

// MySQL "table doesn't exist" (ER_NO_SUCH_TABLE / 1146): the one load error
// that legitimately means "no overrides yet" (pre-migration boot). Anything
// else is a transient failure the loader must NOT paper over with an empty
// override set (M1).
export function isMissingTableError(e) {
    return e?.code === 'ER_NO_SUCH_TABLE' || e?.errno === 1146;
}

// Merge coerced overrides over the config defaults for every catalog key.
export function mergeOverrides(defaults, overrides, catalog = SETTINGS_CATALOG) {
    const out = {};
    for (const e of catalog) {
        const has = overrides && Object.prototype.hasOwnProperty.call(overrides, e.key) && overrides[e.key] != null;
        out[e.key] = has ? coerceValue(e.type, overrides[e.key]) : defaults[e.key];
    }
    return out;
}

// Client-safe subset of an effective settings object (public keys only).
export function publicSubset(effective, catalog = SETTINGS_CATALOG) {
    const out = {};
    for (const e of catalog) if (e.public && e.key in effective) out[e.key] = effective[e.key];
    return out;
}
