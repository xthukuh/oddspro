// Dynamic-settings rules (src/db/settings-rules.js). Pure, offline - catalog
// validation, coercion, merge precedence, public subset.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    SETTINGS_CATALOG, catalogEntry, coerceValue, validateSetting, mergeOverrides, publicSubset,
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
