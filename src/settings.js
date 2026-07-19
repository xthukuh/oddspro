import { db } from './db/connection.js';
import { config } from './config.js';
import {
    SETTINGS_CATALOG, catalogEntry, coerceValue, validateSettings, mergeOverrides, publicSubset,
    isMissingTableError, buildAuditRows, AUDIT_SETTINGS_SET, AUDIT_SETTINGS_RESET,
} from './db/settings-rules.js';

// Dynamic settings service: admin-editable overrides for a curated set of
// operational knobs (src/db/settings-rules.js), merged over the immutable config
// defaults and read LATE - the same late-read idiom as magic.js#safePolicy, so
// an edit takes effect live for wired consumers without a restart. Overrides
// live in the `settings` table; a sync in-memory cache (loaded at boot, reloaded
// on every write) lets hot paths (safePolicy, the auto-refresh tick) read the
// effective value WITHOUT awaiting a query. Every write lands a dated old->new
// row in admin_audit IN THE SAME TRANSACTION (M6) - the policy-regime trail.

let _cache = null; // Map<key,string> | null until first successful load
let _retryTimer = null;
const RETRY_MS = 30_000;

// Load overrides from the DB into the sync cache. Called at server boot and
// after every write. A missing table (pre-migration) is a legitimately empty
// set; any OTHER failure keeps the previous cache (or null -> env defaults)
// and retries - faking an empty Map would silently revert every stored
// override to env defaults for the whole process life, with no log (M1).
// Never rejects.
export async function loadOverrides() {
    try {
        const rows = await db('settings').select('key', 'value');
        _cache = new Map(rows.map(r => [r.key, r.value]));
        if (_retryTimer) { clearTimeout(_retryTimer); _retryTimer = null; }
    } catch (e) {
        if (isMissingTableError(e)) {
            _cache = new Map();
        } else {
            console.error(`[settings] override load failed (${e.message || e}) - `
                + `${_cache ? 'keeping previous overrides' : 'serving env defaults'}, retrying in ${RETRY_MS / 1000}s`);
            _scheduleRetry();
        }
    }
    return _cache;
}

// One pending retry at a time; unref'd so it never holds the process open.
function _scheduleRetry() {
    if (_retryTimer) return;
    _retryTimer = setTimeout(() => { _retryTimer = null; loadOverrides(); }, RETRY_MS);
    _retryTimer.unref?.();
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

// The full config with every catalog override layered on top - the cfg object
// resolveTask/callModel/the AI harness consume (moved here from enrich.js in
// M6 so src/ai/adjudicators.js can share it without the adjudicators ->
// enrich -> hotpicks -> adjudicators cycle; enrich.js re-exports it).
// `overridesFn` is injectable so the layering is assertable OFFLINE without
// priming this module's DB-backed cache.
export function effectiveAiConfig(overridesFn = effectiveConfig) {
    return { ...config, ...overridesFn() };
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
        label: e.label, hint: e.hint, unit: e.unit ?? null,
        regime: e.regime ?? false, pattern: e.pattern ?? null, pattern_hint: e.patternHint ?? null,
        default: config[e.key],
        override: _cache?.has(e.key) ? coerceValue(e.type, _cache.get(e.key)) : null,
        effective: eff[e.key],
    }));
}

// Batch write: validate EVERY key first, then apply inside one transaction,
// reload once. A bad key in the batch must not leave earlier keys already
// persisted+live while the response reads as a rejection (M7). The audit rows
// ride the SAME transaction (M6): an override without its trail (or a trail
// without its override) can never be observed. Throws an error with
// .status 400 carrying every validation message.
export async function setOverrides(entries, userId = null) {
    const batch = validateSettings(entries);
    if (!batch.ok) { const err = new Error(batch.errors.join('; ')); err.status = 400; throw err; }
    await db.transaction(async trx => {
        const keys = entries.map(([key]) => key);
        const stored = await trx('settings').whereIn('key', keys).select('key', 'value').forUpdate();
        const previous = Object.fromEntries(stored.map(r => [r.key, r.value]));
        for (const [key, value] of entries) {
            await trx('settings')
                .insert({ key, value: String(value), updated_by: userId })
                .onConflict('key').merge({ value: String(value), updated_by: userId });
        }
        const audit = buildAuditRows(entries, previous, { actorId: userId, action: AUDIT_SETTINGS_SET });
        if (audit.length) await trx('admin_audit').insert(audit);
    });
    await loadOverrides();
    return entries.map(([key]) => ({ key, effective: effective(key), restart_required: !catalogEntry(key).live }));
}

export async function resetOverride(key, userId = null) {
    if (!catalogEntry(key)) { const err = new Error(`Unknown setting: ${key}`); err.status = 400; throw err; }
    await db.transaction(async trx => {
        const stored = await trx('settings').where('key', key).select('value').forUpdate().first();
        await trx('settings').where('key', key).del();
        // No stored override -> nothing changed -> no trail (buildAuditRows
        // drops the null->null row by the same changed-only contract).
        const audit = buildAuditRows([[key, null]], { [key]: stored?.value ?? null },
            { actorId: userId, action: AUDIT_SETTINGS_RESET });
        if (audit.length) await trx('admin_audit').insert(audit);
    });
    await loadOverrides();
    return { key, effective: effective(key), restart_required: !catalogEntry(key).live };
}

// Recent admin actions, newest first - GET /api/admin/settings/audit (M6).
// Left-joined to users so the editor shows WHO; a deleted actor renders null
// (the SET NULL pointer keeps the trail itself).
export async function auditTrail({ limit = 50 } = {}) {
    const rows = await db('admin_audit as a')
        .leftJoin('users as u', 'u.id', 'a.actor_id')
        .orderBy('a.id', 'desc')
        .limit(Math.min(Math.max(Number(limit) || 50, 1), 500))
        .select('a.id', 'a.actor_id', 'u.phone as actor_phone', 'a.action', 'a.target',
            'a.old_value', 'a.new_value', 'a.created_at');
    return rows;
}
