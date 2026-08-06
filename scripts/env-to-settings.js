// Migrate load-bearing .env runtime overrides into the settings table so the
// .env can be trimmed to credentials/boot infra without changing any effective
// value (the settings override outranks the .env fallback and is audit-dated).
// Selection = env-audit.js's DIFFERS set intersected with the settings catalog:
// keys present in .env, known to the config schema, differing from the code
// default, and admin-editable. Values are written through the canonical
// validated setOverrides() path (actor null = system migration).
//
//   node scripts/env-to-settings.js        # dry-run: shows what would be written
//   node scripts/env-to-settings.js --yes  # persist + verify effective values
import { readFileSync } from 'node:fs';
import dotenv from 'dotenv';
import { config, EnvSchema } from '../src/config.js';
import { SETTINGS_CATALOG } from '../src/db/settings-rules.js';
import { loadOverrides, setOverrides, effective } from '../src/settings.js';
import { closeDb } from '../src/db/connection.js';

const confirmed = process.argv.includes('--yes');

const envKeys = Object.keys(dotenv.parse(readFileSync('.env', 'utf8')));
const shape = EnvSchema.shape;
const defaults = EnvSchema.parse({ X_APISPORTS_KEY: 'audit-placeholder' });
const catalogKeys = new Set(SETTINGS_CATALOG.map(e => e.key));

const pairs = envKeys
    .filter(key => key in shape && catalogKeys.has(key)
        && JSON.stringify(config[key]) !== JSON.stringify(defaults[key]))
    .map(key => [key, config[key]]);

try {
    if (!pairs.length) {
        console.log('[env-to-settings] nothing to migrate - no admin-editable .env key differs from its default.');
    } else {
        await loadOverrides();
        console.log(`[env-to-settings] ${pairs.length} admin-editable override(s) in .env:`);
        for (const [key, value] of pairs) {
            const cur = effective(key);
            console.log(`  ${key} = ${JSON.stringify(value)}${JSON.stringify(cur) !== JSON.stringify(value) ? `  (current effective ${JSON.stringify(cur)})` : ''}`);
        }
        if (!confirmed) {
            console.log('\nDry-run. Re-run with --yes to persist these into the settings table.');
        } else {
            await setOverrides(pairs, null);
            let bad = 0;
            for (const [key, value] of pairs) {
                const eff = effective(key);
                if (JSON.stringify(eff) !== JSON.stringify(value)) {
                    console.error(`  MISMATCH after write: ${key} effective ${JSON.stringify(eff)} != ${JSON.stringify(value)}`);
                    bad++;
                }
            }
            if (bad) process.exitCode = 1;
            else console.log(`\nPersisted ${pairs.length} override(s); every effective value verified unchanged. The .env lines can now be trimmed.`);
        }
    }
} finally {
    await closeDb();
}
