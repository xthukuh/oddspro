// .env audit: reports which lines in the local .env are load-bearing and which
// are noise, so the file can be kept lean without repeating the 2026-07-26
// trap (a "cleaned" .env silently dropped LINK_MIN_CONFIDENCE=0.8 and made the
// linker stricter). READ-ONLY: prints a report, never edits the file.
//
// Categories:
//   SECRET    - credentials/keys: keep in .env (never the settings catalog).
//   DIFFERS   - value differs from the code default: LOAD-BEARING, keep (or
//               move to Admin -> Settings when the key is in the catalog -
//               a DB override outranks .env and is audit-dated).
//   REDUNDANT - value equals the code default: the line changes nothing.
//   UNKNOWN   - not in the config schema at all: ignored by zod entirely.
//
// Usage: node scripts/env-audit.js
import { readFileSync } from 'node:fs';
import dotenv from 'dotenv';
import { config, EnvSchema } from '../src/config.js';
import { SETTINGS_CATALOG } from '../src/db/settings-rules.js';

const SECRET_RX = /(KEY|TOKEN|PASSWORD|SECRET|PEPPER|CLIENT_ID)$/;

const envText = readFileSync('.env', 'utf8');
const envKeys = Object.keys(dotenv.parse(envText));
const shape = EnvSchema.shape;
// Defaults view: parse a minimal env carrying only the required key(s).
const defaults = EnvSchema.parse({ X_APISPORTS_KEY: 'audit-placeholder' });
const catalogKeys = new Set(SETTINGS_CATALOG.map(e => e.key));

const rows = { SECRET: [], DIFFERS: [], REDUNDANT: [], UNKNOWN: [] };
for (const key of envKeys) {
    if (!(key in shape)) {
        rows.UNKNOWN.push({ key });
        continue;
    }
    if (SECRET_RX.test(key)) {
        rows.SECRET.push({ key });
        continue;
    }
    const same = JSON.stringify(config[key]) === JSON.stringify(defaults[key]);
    (same ? rows.REDUNDANT : rows.DIFFERS).push({
        key,
        value: JSON.stringify(config[key]),
        dflt: JSON.stringify(defaults[key]),
        admin: catalogKeys.has(key),
    });
}

console.log(`.env audit - ${envKeys.length} keys\n`);
console.log(`SECRET (keep in .env) - ${rows.SECRET.length}`);
for (const r of rows.SECRET) console.log(`  ${r.key}`);
console.log(`\nDIFFERS from default (LOAD-BEARING - keep, or migrate to Admin -> Settings where marked) - ${rows.DIFFERS.length}`);
for (const r of rows.DIFFERS) console.log(`  ${r.key} = ${r.value}  (default ${r.dflt})${r.admin ? '  [admin-editable]' : ''}`);
console.log(`\nREDUNDANT (equals the code default - the line changes nothing) - ${rows.REDUNDANT.length}`);
for (const r of rows.REDUNDANT) console.log(`  ${r.key} = ${r.value}${r.admin ? '  [admin-editable]' : ''}`);
console.log(`\nUNKNOWN (not in the schema - ignored entirely) - ${rows.UNKNOWN.length}`);
for (const r of rows.UNKNOWN) console.log(`  ${r.key}`);
console.log('\nNothing was modified. Trim REDUNDANT/UNKNOWN lines freely; NEVER drop a DIFFERS line without intending the default.');
