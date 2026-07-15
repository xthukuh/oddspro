// Dynamic-settings rules (src/db/settings-rules.js). Pure, offline - catalog
// validation, coercion, merge precedence, public subset.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    SETTINGS_CATALOG, catalogEntry, coerceValue, validateSetting, validateSettings,
    mergeOverrides, publicSubset, isMissingTableError, settingsPutSchema,
} from '../src/db/settings-rules.js';

test('catalog excludes secrets/creds/build vars by construction', () => {
    const keys = new Set(SETTINGS_CATALOG.map(e => e.key));
    for (const forbidden of ['X_APISPORTS_KEY', 'PIN_PEPPER', 'ADMIN_TOKEN', 'API_TOKEN',
        'HUMAN_TOKEN_SECRET', 'BONGA_API_SECRET', 'DB_PASSWORD', 'VITE_HUMAN_POW']) {
        assert.equal(keys.has(forbidden), false, `${forbidden} must NOT be editable`);
    }
    assert.equal(keys.has('SAFE_MAX_PRICE'), true);
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
