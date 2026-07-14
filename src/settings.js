import { db } from './db/connection.js';
import { config } from './config.js';
import {
    SETTINGS_CATALOG, catalogEntry, coerceValue, validateSetting, mergeOverrides, publicSubset,
} from './db/settings-rules.js';

// Dynamic settings service: admin-editable overrides for a curated set of
// operational knobs (src/db/settings-rules.js), merged over the immutable config
// defaults and read LATE - the same late-read idiom as magic.js#safePolicy, so
// an edit takes effect live for wired consumers without a restart. Overrides
// live in the `settings` table; a sync in-memory cache (loaded at boot, reloaded
// on every write) lets hot paths (safePolicy, the auto-refresh tick) read the
// effective value WITHOUT awaiting a query.

let _cache = null; // Map<key,string> | null until first load

// Load overrides from the DB into the sync cache. Called at server boot and
// after every write. Safe to call before the table exists (returns empty).
export async function loadOverrides() {
    try {
        const rows = await db('settings').select('key', 'value');
        _cache = new Map(rows.map(r => [r.key, r.value]));
    } catch {
        _cache = new Map(); // pre-migration / DB hiccup: fall back to config defaults
    }
    return _cache;
}

function overridesObj() {
    const o = {};
    if (_cache) for (const [k, v] of _cache) o[k] = v;
    return o;
}

// Effective value for one key: override (coerced) over the config default.
// Falls back to config when the cache isn't loaded or the key isn't overridden.
export function effective(key) {
    const e = catalogEntry(key);
    if (!e) return config[key];
    if (_cache && _cache.has(key)) return coerceValue(e.type, _cache.get(key));
    return config[key];
}

// The whole merged settings object (every catalog key).
export function effectiveConfig() {
    return mergeOverrides(config, overridesObj(), SETTINGS_CATALOG);
}

// Public (client-safe) subset shipped via GET /api/settings.
export function publicSettings() {
    return publicSubset(effectiveConfig(), SETTINGS_CATALOG);
}

// Full admin view: default / override / effective / metadata per catalog key.
export function adminSettings() {
    const eff = effectiveConfig();
    return SETTINGS_CATALOG.map(e => ({
        key: e.key, group: e.group, type: e.type, public: e.public, live: e.live,
        min: e.min ?? null, max: e.max ?? null, enum: e.enum ?? null,
        default: config[e.key],
        override: _cache?.has(e.key) ? coerceValue(e.type, _cache.get(e.key)) : null,
        effective: eff[e.key],
    }));
}

// Set/replace one override. Validates against the catalog, upserts, reloads the
// cache. Returns { effective, restart_required }. Throws an error with .status
// 400 on an invalid value.
export async function setOverride(key, rawValue, userId = null) {
    const v = validateSetting(key, rawValue);
    if (!v.ok) { const err = new Error(v.error); err.status = 400; throw err; }
    await db('settings')
        .insert({ key, value: String(rawValue), updated_by: userId })
        .onConflict('key').merge({ value: String(rawValue), updated_by: userId });
    await loadOverrides();
    return { key, effective: effective(key), restart_required: !catalogEntry(key).live };
}

export async function resetOverride(key) {
    if (!catalogEntry(key)) { const err = new Error(`Unknown setting: ${key}`); err.status = 400; throw err; }
    await db('settings').where('key', key).del();
    await loadOverrides();
    return { key, effective: effective(key), restart_required: !catalogEntry(key).live };
}
