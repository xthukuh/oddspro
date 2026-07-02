// Offline canary for the scraper -> store contract: the frozen legacy
// snapshots at the repo root (x-*-output.xx.json) are real standardized
// scraper outputs; every record must satisfy the shape `store.saveMatches`
// consumes. If a scraper change breaks this schema, this fails without
// hitting any live bookmaker API.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { marketKey } from '../src/markets.js';

const _root = p => fileURLToPath(new URL(`../${p}`, import.meta.url));

// Standardized market entry (input to store._marketRows)
const MarketSchema = z.object({
    type_id: z.number().nullable().optional(),
    type_name: z.string().min(1),
    type_explainer: z.string().nullable().optional(),
    name: z.string().min(1),
    price: z.number().finite(),
    handicap: z.number().nullable().optional(),
    probability: z.number().nullable().optional(),
});

// Standardized game record (input to store._matchRow); tolerant nullables
// per convention - betika lacks provider/team ids/region/competition ids.
const GameSchema = z.object({
    provider: z.string().nullable().optional(),
    match_id: z.number(),
    match_url: z.string().min(1),
    start_time: z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/),
    home_team_id: z.number().nullable(),
    home_team_name: z.string().min(1),
    away_team_id: z.number().nullable(),
    away_team_name: z.string().min(1),
    home_score_first_half: z.number().nullable(),
    home_score_second_half: z.number().nullable(),
    home_score_fulltime: z.number().nullable(),
    away_score_first_half: z.number().nullable(),
    away_score_second_half: z.number().nullable(),
    away_score_fulltime: z.number().nullable(),
    region_id: z.number().nullable(),
    region_name: z.string().nullable(),
    category_id: z.number().nullable(),
    category_name: z.string().nullable(),
    competition_id: z.number().nullable(),
    competition_name: z.string().nullable(),
    markets: z.array(MarketSchema),
});

for (const file of ['x-betpawa-output.xx.json', 'x-betika-output.xx.json']) {
    test(`${file} matches the standardized game record contract`, () => {
        const raw = JSON.parse(readFileSync(_root(file), 'utf8'));
        assert.ok(Array.isArray(raw) && raw.length, 'snapshot is a non-empty array');
        // Legacy artifact: failed detail fetches left sparse-array holes that
        // serialize as null. The live path can't produce them (_batch rejects
        // on first error), so the contract covers non-null records only.
        const games = raw.filter(g => g != null);

        const failures = [];
        let markets = 0, canonical = 0;
        for (const [i, g] of games.entries()) {
            const res = GameSchema.safeParse(g);
            if (!res.success) {
                if (failures.length < 5) failures.push(`#${i} (${g?.match_id}): ${res.error.issues[0]?.message}`);
                continue;
            }
            markets += g.markets.length;
            canonical += g.markets.some(m => marketKey(m)) ? 1 : 0;
        }
        assert.deepEqual(failures, [], `${failures.length ? failures.join('; ') : ''}`);
        assert.ok(markets > 0, 'snapshot carries market entries');
        assert.ok(canonical > 0, 'canonical market spellings still map (markets.js registry)');
    });
}
