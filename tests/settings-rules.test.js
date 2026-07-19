// Dynamic-settings rules (src/db/settings-rules.js). Pure, offline - catalog
// validation, coercion, merge precedence, public subset.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    SETTINGS_CATALOG, catalogEntry, coerceValue, validateSetting, validateSettings,
    mergeOverrides, publicSubset, isMissingTableError, settingsPutSchema,
    buildAuditRows, AUDIT_SETTINGS_SET, AUDIT_SETTINGS_RESET,
    normalizeForCompare, settingsDiff,
} from '../src/db/settings-rules.js';

test('catalog excludes secrets/creds/build vars by construction', () => {
    const keys = new Set(SETTINGS_CATALOG.map(e => e.key));
    for (const forbidden of ['X_APISPORTS_KEY', 'PIN_PEPPER', 'ADMIN_TOKEN', 'API_TOKEN',
        'BONGA_API_SECRET', 'DB_PASSWORD', 'OPENROUTER_API_KEY']) {
        assert.equal(keys.has(forbidden), false, `${forbidden} must NOT be editable`);
    }
    assert.equal(keys.has('SAFE_MAX_PRICE'), true);
    // Every SAFE_* policy knob is admin-editable - the M3 maturity floor too.
    assert.equal(keys.has('SAFE_MIN_MARKET_SETTLED'), true);
});

test('coerceValue by type (booleans never coerce "0" to true)', () => {
    assert.equal(coerceValue('int', '3'), 3);
    assert.equal(coerceValue('number', '1.6'), 1.6);
    assert.equal(coerceValue('boolean', '0'), false);
    assert.equal(coerceValue('boolean', 'true'), true);
    assert.equal(coerceValue('boolean', '1'), true);
    assert.equal(coerceValue('string', 'market'), 'market');
});

test('validateSetting enforces type + min/max and rejects unknown keys', () => {
    assert.equal(validateSetting('NOPE', '1').ok, false);
    assert.equal(validateSetting('DB_PASSWORD', 'x').ok, false); // not in catalog
    assert.deepEqual(validateSetting('SAFE_MAX_PRICE', '1.6'), { ok: true, value: 1.6 });
    assert.equal(validateSetting('SAFE_MAX_PRICE', '0.5').ok, false); // < min 1
    assert.equal(validateSetting('SAFE_MIN_PARTS', '5').ok, false);   // > max 3
    assert.equal(validateSetting('SAFE_MIN_PARTS', '2.5').ok, false); // not int
    assert.equal(validateSetting('SAFE_MIN_PARTS', '2').value, 2);
    // M3 maturity floor: int >= 0, public + live like its SAFE_* siblings
    assert.deepEqual(validateSetting('SAFE_MIN_MARKET_SETTLED', '30'), { ok: true, value: 30 });
    assert.equal(validateSetting('SAFE_MIN_MARKET_SETTLED', '-1').ok, false); // < min 0
    assert.equal(validateSetting('SAFE_MIN_MARKET_SETTLED', '2.5').ok, false); // not int
});

test('mergeOverrides: override wins, else config default; only catalog keys', () => {
    const defaults = { SAFE_MAX_PRICE: 1.6, SAFE_MAX_PER_DAY: 3, DB_PASSWORD: 'secret' };
    const merged = mergeOverrides(defaults, { SAFE_MAX_PRICE: '1.8' });
    assert.equal(merged.SAFE_MAX_PRICE, 1.8);   // overridden + coerced to number
    assert.equal(merged.SAFE_MAX_PER_DAY, 3);   // default
    assert.equal('DB_PASSWORD' in merged, false); // never merged (not in catalog)
    // a null/absent override falls back to the default
    assert.equal(mergeOverrides(defaults, { SAFE_MAX_PRICE: null }).SAFE_MAX_PRICE, 1.6);
});

test('publicSubset keeps only public keys', () => {
    const eff = mergeOverrides(
        { SAFE_MAX_PRICE: 1.6, REFRESH_COOLDOWN_MINUTES: 60, SMS_ENABLED: false },
        {},
    );
    const pub = publicSubset(eff);
    assert.equal('SAFE_MAX_PRICE' in pub, true);           // public
    assert.equal('REFRESH_COOLDOWN_MINUTES' in pub, false); // not public
    assert.equal('SMS_ENABLED' in pub, false);              // not public
});

// M7: batch validation - ALL keys validate before ANY write (all-or-nothing).
test('validateSettings validates every entry up front', () => {
    const ok = validateSettings([['SAFE_MAX_PRICE', '1.8'], ['SAFE_MIN_PARTS', '2']]);
    assert.equal(ok.ok, true);
    assert.deepEqual(ok.values, [
        { key: 'SAFE_MAX_PRICE', value: 1.8 },
        { key: 'SAFE_MIN_PARTS', value: 2 },
    ]);
    // One bad key fails the WHOLE batch and reports every error, not just the first.
    const bad = validateSettings([['SAFE_MAX_PRICE', '1.8'], ['NOPE', '1'], ['SAFE_MIN_PARTS', '9']]);
    assert.equal(bad.ok, false);
    assert.equal(bad.errors.length, 2);
    assert.match(bad.errors[0], /NOPE/);
    assert.match(bad.errors[1], /SAFE_MIN_PARTS/);
    // Empty batch is a validation error, not a silent no-op success.
    assert.equal(validateSettings([]).ok, false);
});

// M1: the boot override-load must tell "table not migrated yet" (legitimately
// empty) apart from a transient DB failure (keep cache, retry).
test('isMissingTableError matches only the MySQL missing-table error', () => {
    assert.equal(isMissingTableError({ code: 'ER_NO_SUCH_TABLE', errno: 1146 }), true);
    assert.equal(isMissingTableError({ errno: 1146 }), true);
    assert.equal(isMissingTableError({ code: 'ECONNREFUSED' }), false);
    assert.equal(isMissingTableError({ code: 'ER_LOCK_DEADLOCK', errno: 1213 }), false);
    assert.equal(isMissingTableError(new Error('boom')), false);
    assert.equal(isMissingTableError(null), false);
});

test('catalogEntry carries the live flag (restart vs live)', () => {
    assert.equal(catalogEntry('SAFE_MAX_PRICE').live, true);
    assert.equal(catalogEntry('AUTO_FULL_AT').live, false);
    // H3: SMS + bot-UA consumers late-read effective() per call/request -> live;
    // geo reads effective() once at scheduler start -> restart required.
    assert.equal(catalogEntry('SMS_ENABLED').live, true);
    assert.equal(catalogEntry('BOT_UA_FILTER_ENABLED').live, true);
    assert.equal(catalogEntry('GEO_RESOLVE_ENABLED').live, false);
    assert.equal(catalogEntry('NOPE'), null);
});

test('settingsPutSchema pins the PUT body envelope (C2)', () => {
    assert.equal(settingsPutSchema.parse({ key: 'SAFE_MAX_PER_DAY', value: 4 }).key, 'SAFE_MAX_PER_DAY');
    assert.deepEqual(settingsPutSchema.parse({ overrides: { SMS_ENABLED: '1' } }).overrides, { SMS_ENABLED: '1' });
    assert.equal(settingsPutSchema.safeParse({}).success, false);          // neither form
    assert.equal(settingsPutSchema.safeParse({ key: '' }).success, false); // blank key
    assert.equal(settingsPutSchema.safeParse({ value: 4 }).success, false); // value without key
});

// ---- M6: catalog metadata, regime flags, patterns, audit builder ----------

test('M6 catalog completeness: every entry has label, hint, known group/type', () => {
    const GROUPS = new Set(['safe', 'refresh', 'pipeline', 'hotpick', 'tip', 'ai', 'ai-dark',
        'auth-policy', 'otp', 'sms', 'mail', 'geo', 'bot', 'logging', 'tracking', 'maintenance']);
    const TYPES = new Set(['string', 'int', 'number', 'boolean']);
    for (const e of SETTINGS_CATALOG) {
        assert.equal(typeof e.label === 'string' && e.label.length > 0, true, `${e.key} needs a label`);
        assert.equal(typeof e.hint === 'string' && e.hint.length > 0, true, `${e.key} needs a hint`);
        assert.equal(GROUPS.has(e.group), true, `${e.key} has unknown group ${e.group}`);
        assert.equal(TYPES.has(e.type), true, `${e.key} has unknown type ${e.type}`);
        assert.equal(typeof e.public, 'boolean', `${e.key} needs an explicit public flag`);
        assert.equal(typeof e.live, 'boolean', `${e.key} needs an explicit live flag`);
        if (e.pattern) assert.doesNotThrow(() => new RegExp(e.pattern), `${e.key} pattern must compile`);
    }
    // The M6 expansion actually landed (~74 keys, was 30).
    assert.equal(SETTINGS_CATALOG.length >= 70, true, `catalog unexpectedly small: ${SETTINGS_CATALOG.length}`);
});

test('M6 regime flags: TIP_*/HOTPICK_*/SAFE_* + DARK switches, concurrency exempt', () => {
    for (const e of SETTINGS_CATALOG) {
        const wildcard = /^(TIP_|HOTPICK_|SAFE_)/.test(e.key) && e.key !== 'HOTPICK_AI_CONCURRENCY';
        const dark = e.group === 'ai-dark';
        assert.equal(Boolean(e.regime), wildcard || dark,
            `${e.key} regime flag should be ${wildcard || dark}`);
    }
    // Spot checks for the flags the plan names explicitly.
    assert.equal(catalogEntry('TIP_MIN_PRICE').regime, true);
    assert.equal(catalogEntry('TIP_AI_MIN_CONFIDENCE').regime, true);
    assert.equal(catalogEntry('AI_INJECTION_PREAMBLE').regime, true);
    assert.equal(catalogEntry('HOTPICK_AI_CONCURRENCY').regime ?? false, false); // mechanical throughput
    assert.equal(catalogEntry('OTP_TTL_MINUTES').regime ?? false, false);
});

test('M6 pattern validation accepts the real formats and rejects junk', () => {
    // HOTPICK_LINES: numbers CSV
    assert.equal(validateSetting('HOTPICK_LINES', '2.5').ok, true);
    assert.equal(validateSetting('HOTPICK_LINES', '1.5, 2.5').ok, true);
    assert.equal(validateSetting('HOTPICK_LINES', 'abc').ok, false);
    assert.equal(validateSetting('HOTPICK_LINES', '2.5;3.5').ok, false);
    assert.equal(validateSetting('HOTPICK_LINES', '').ok, false);
    // AUTO_FULL_AT: HH:mm / off / blank
    assert.equal(validateSetting('AUTO_FULL_AT', '06:00').ok, true);
    assert.equal(validateSetting('AUTO_FULL_AT', '6:00').ok, true);
    assert.equal(validateSetting('AUTO_FULL_AT', 'off').ok, true);
    assert.equal(validateSetting('AUTO_FULL_AT', '').ok, true);
    assert.equal(validateSetting('AUTO_FULL_AT', '25:00').ok, false);
    assert.equal(validateSetting('AUTO_FULL_AT', 'noon').ok, false);
    // ODDS_REFRESH_TIERS: upTo:maxAge CSV with * catch-all
    assert.equal(validateSetting('ODDS_REFRESH_TIERS', '90:0,360:30,1440:120,*:360').ok, true);
    assert.equal(validateSetting('ODDS_REFRESH_TIERS', 'off').ok, true);
    assert.equal(validateSetting('ODDS_REFRESH_TIERS', '90-0').ok, false);
    // SMS_DEFAULT_REGION: two-letter ISO
    assert.equal(validateSetting('SMS_DEFAULT_REGION', 'KE').ok, true);
    assert.equal(validateSetting('SMS_DEFAULT_REGION', 'kenya').ok, false);
    // GEO_API_BATCH_URL: http(s) URL
    assert.equal(validateSetting('GEO_API_BATCH_URL', 'http://ip-api.com/batch').ok, true);
    assert.equal(validateSetting('GEO_API_BATCH_URL', 'ftp://x').ok, false);
    // AI consensus CSVs (blank = off is always valid)
    assert.equal(validateSetting('AI_CONSENSUS_TASKS', '').ok, true);
    assert.equal(validateSetting('AI_CONSENSUS_TASKS', 'adjudicate').ok, true);
    assert.equal(validateSetting('AI_CONSENSUS_TASKS', 'Bad Task!').ok, false);
    assert.equal(validateSetting('AI_CONSENSUS_MODELS', '').ok, true);
    assert.equal(validateSetting('AI_CONSENSUS_MODELS', 'gemini:gemini-2.5-pro,openrouter:openai/gpt-5.6-terra').ok, true);
    assert.equal(validateSetting('AI_CONSENSUS_MODELS', 'no-colon-model').ok, false);
    // M14 maintenance window: EAT datetime bounds + closed-placeholder message
    assert.equal(validateSetting('MAINTENANCE_START', '2026-07-19 22:00').ok, true);
    assert.equal(validateSetting('MAINTENANCE_START', '').ok, true);            // blank = unset
    assert.equal(validateSetting('MAINTENANCE_START', '2026-07-19T22:00').ok, false);
    assert.equal(validateSetting('MAINTENANCE_END', 'tomorrow').ok, false);
    assert.equal(validateSetting('MAINTENANCE_MESSAGE', 'Down from ${downtime_start} to ${downtime_end}').ok, true);
    assert.equal(validateSetting('MAINTENANCE_MESSAGE', '').ok, true);          // blank = default wording
    assert.equal(validateSetting('MAINTENANCE_MESSAGE', 'Hi ${name}').ok, false); // unknown placeholder
});

test('M6 SAFE_STRATEGY enum comes from the real STRATEGIES registry', () => {
    assert.equal(validateSetting('SAFE_STRATEGY', 'sure').ok, true);
    assert.equal(validateSetting('SAFE_STRATEGY', 'market').ok, true);
    assert.equal(validateSetting('SAFE_STRATEGY', 'not-a-strategy').ok, false);
});

test('M6 new-key validation: ranges enforced like the originals', () => {
    assert.deepEqual(validateSetting('TIP_MIN_PRICE', '1.3'), { ok: true, value: 1.3 });
    assert.equal(validateSetting('TIP_MIN_PRICE', '0.9').ok, false);   // < min 1
    assert.equal(validateSetting('OTP_LENGTH', '3').ok, false);        // < min 4
    assert.equal(validateSetting('GEO_BATCH_LIMIT', '101').ok, false); // > ip-api cap
    assert.equal(validateSetting('HOTPICK_TEAM_WINDOW', '9').ok, false); // > backfill depth 8
    assert.equal(validateSetting('AI_CONSENSUS_MIN_AGREE', '1').ok, false); // < 2
});

test('M6 secrets/boot switches stay OUT of the catalog by construction', () => {
    const keys = new Set(SETTINGS_CATALOG.map(e => e.key));
    for (const forbidden of ['GEMINI_API_KEY', 'BONGA_API_CLIENT_ID', 'BONGA_API_KEY',
        'BONGA_API_SECRET', 'BONGA_API_URL_SEND', 'AUTH_ENABLED', 'ADMIN_SEED_PIN',
        'MIGRATE_ON_BOOT', 'API_HOST', 'API_PORT']) {
        assert.equal(keys.has(forbidden), false, `${forbidden} must NOT be admin-editable`);
    }
});

test('M6 public subset is EXACTLY the SAFE_* keys (no new key leaked public)', () => {
    const pub = SETTINGS_CATALOG.filter(e => e.public).map(e => e.key).sort();
    assert.deepEqual(pub, ['SAFE_MAX_PER_DAY', 'SAFE_MAX_PRICE', 'SAFE_MIN_AGREEMENT',
        'SAFE_MIN_H2H', 'SAFE_MIN_MARKET_SETTLED', 'SAFE_MIN_PARTS', 'SAFE_MIN_SAMPLES',
        'SAFE_STRATEGY']);
});

test('buildAuditRows: changed-only trail with old/new values', () => {
    const rows = buildAuditRows(
        [['TIP_MIN_PRICE', 1.3], ['SAFE_MAX_PER_DAY', '3'], ['SMS_ENABLED', '1']],
        { TIP_MIN_PRICE: '1.2', SAFE_MAX_PER_DAY: '3' }, // SAFE unchanged -> no row
        { actorId: 7 });
    assert.deepEqual(rows, [
        { actor_id: 7, action: AUDIT_SETTINGS_SET, target: 'TIP_MIN_PRICE', old_value: '1.2', new_value: '1.3' },
        { actor_id: 7, action: AUDIT_SETTINGS_SET, target: 'SMS_ENABLED', old_value: null, new_value: '1' },
    ]);
});

// ---- M7: semantic dirty-state (normalizeForCompare + settingsDiff) --------

test('normalizeForCompare: numbers, blanks, booleans, strings', () => {
    const num = { type: 'number' };
    assert.equal(normalizeForCompare(num, '1.60'), 1.6);  // textual != semantic
    assert.equal(normalizeForCompare(num, 1.6), 1.6);
    assert.equal(normalizeForCompare(num, ''), null);     // blank numeric = no value
    assert.equal(normalizeForCompare(num, '  '), null);
    assert.equal(normalizeForCompare(num, null), null);
    assert.equal(normalizeForCompare(num, 'abc'), 'abc'); // junk stays raw -> dirty -> server 400s
    const bool = { type: 'boolean' };
    assert.equal(normalizeForCompare(bool, true), true);
    assert.equal(normalizeForCompare(bool, 'true'), true);
    assert.equal(normalizeForCompare(bool, '1'), true);
    assert.equal(normalizeForCompare(bool, false), false);
    assert.equal(normalizeForCompare(bool, '0'), false);
    const str = { type: 'string' };
    assert.equal(normalizeForCompare(str, '  market '), 'market');
    // Blank STRING stays a value - AUTO_FULL_AT '' means "sweep off", which is
    // NOT the same as resetting to the default time.
    assert.equal(normalizeForCompare(str, ''), '');
});

test('settingsDiff: revert=clean, bool norm, changed values only', () => {
    const rows = [
        { key: 'SAFE_MAX_PRICE', type: 'number', override: null, default: 1.6, effective: 1.6 },
        { key: 'SMS_ENABLED', type: 'boolean', override: null, default: false, effective: false },
        { key: 'SAFE_STRATEGY', type: 'string', override: null, default: 'market', effective: 'market' },
    ];
    assert.equal(settingsDiff(rows, {}).count, 0);
    // Typing the shown value back (or a textual variant of it) is clean.
    assert.equal(settingsDiff(rows, { SAFE_MAX_PRICE: '1.60' }).count, 0);
    assert.equal(settingsDiff(rows, { SMS_ENABLED: false }).count, 0);
    assert.equal(settingsDiff(rows, { SAFE_STRATEGY: 'market' }).count, 0);
    // Real changes land in set, coerced.
    const d = settingsDiff(rows, { SAFE_MAX_PRICE: '1.8', SMS_ENABLED: true, SAFE_STRATEGY: 'sure' });
    assert.equal(d.count, 3);
    assert.deepEqual(d.set, { SAFE_MAX_PRICE: 1.8, SMS_ENABLED: true, SAFE_STRATEGY: 'sure' });
    assert.deepEqual(d.reset, []);
    // Unknown keys are ignored (stale local edit vs a changed catalog).
    assert.equal(settingsDiff(rows, { NOPE: '1' }).count, 0);
});

test('settingsDiff: blank numeric == default; reset when overridden', () => {
    const clean = { key: 'SAFE_MAX_PER_DAY', type: 'int', override: null, default: 3, effective: 3 };
    const overridden = { key: 'SAFE_MAX_PRICE', type: 'number', override: 1.8, default: 1.6, effective: 1.8 };
    // Blank on a non-overridden numeric = "use the default" -> clean.
    assert.equal(settingsDiff([clean], { SAFE_MAX_PER_DAY: '' }).count, 0);
    // Blank on an OVERRIDDEN numeric = clear the override -> a reset entry.
    const d = settingsDiff([overridden], { SAFE_MAX_PRICE: '' });
    assert.deepEqual(d.reset, ['SAFE_MAX_PRICE']);
    assert.deepEqual(d.set, {});
    assert.equal(d.count, 1);
    // Typing the override value back is clean; typing the DEFAULT over an
    // override is a real change (the running value moves 1.8 -> 1.6).
    assert.equal(settingsDiff([overridden], { SAFE_MAX_PRICE: '1.8' }).count, 0);
    assert.deepEqual(settingsDiff([overridden], { SAFE_MAX_PRICE: '1.6' }).set, { SAFE_MAX_PRICE: 1.6 });
});

test('buildAuditRows: reset rows and the never-overridden no-op', () => {
    // Reset of a stored override -> old value recorded, new null.
    assert.deepEqual(buildAuditRows([['TIP_MIN_PRICE', null]], { TIP_MIN_PRICE: '1.35' },
        { actorId: null, action: AUDIT_SETTINGS_RESET }), [
        { actor_id: null, action: AUDIT_SETTINGS_RESET, target: 'TIP_MIN_PRICE', old_value: '1.35', new_value: null },
    ]);
    // Resetting a key that was never overridden changes nothing -> no trail.
    assert.deepEqual(buildAuditRows([['TIP_MIN_PRICE', null]], {},
        { action: AUDIT_SETTINGS_RESET }), []);
});
