// Pins src/enrich.js's `buildTargetsQuery` to the leakage-critical projection
// and filter it MUST carry. Fix pass 2, finding A: tests/enrich-rules.test.js
// only pinned KICKOFF_SQL_EXPR's own string and the pure selectEnrichable()
// guard - nothing asserted that `_loadTargets` (src/enrich.js) actually FEEDS
// that string to the query. A reviewer confirmed reverting src/enrich.js's
// kickoff projection back to a bare `'f.kickoff'` select left all 550 tests
// green. This file closes that gap by compiling the real query offline (no
// DB - `knex({ client: 'mysql2' })` never connects, and `.toSQL()` only
// compiles SQL, same idiom as tests/market-identity.test.js) and asserting
// on the compiled SQL string itself, so reverting either the projection or
// the strict `kickoff > NOW()` filter turns this test red.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import knex from 'knex';
import { buildTargetsQuery, effectiveAiConfig, assertAiProvidersConfigured } from '../src/enrich.js';
import { KICKOFF_SQL_EXPR, CORRELATION_GUARDS, resolveTask } from '../src/db/ai-rules.js';
import { config } from '../src/config.js';

test('buildTargetsQuery projects the offset-qualified KICKOFF_SQL_EXPR, not a bare kickoff column (TZ HAZARD BINDING)', () => {
    const kx = knex({ client: 'mysql2' }); // disconnected builder - no queries run
    const sql = buildTargetsQuery(kx).toSQL().sql;

    // The exact offset-qualified expression must be embedded verbatim. A
    // regression to `.select(..., 'f.kickoff', ...)` would instead compile
    // to "`f`.`kickoff` as `kickoff`" - a substring match against the real
    // constant is what catches that silently-permissive revert.
    assert.ok(
        sql.includes(`${KICKOFF_SQL_EXPR} as kickoff`),
        `expected the compiled SQL to project KICKOFF_SQL_EXPR verbatim, got:\n${sql}`,
    );
    assert.ok(
        !/`f`\.`kickoff`\s+as\s+`kickoff`/i.test(sql),
        `compiled SQL projects a bare/naive kickoff column - the exact TZ hazard this guard exists to prevent:\n${sql}`,
    );
});

test('buildTargetsQuery filters strictly on kickoff > NOW() (LEAKAGE GUARD, SQL-side belt)', () => {
    const kx = knex({ client: 'mysql2' });
    const sql = buildTargetsQuery(kx).toSQL().sql;
    assert.ok(
        /`f`\.`kickoff`\s*>\s*NOW\(\)/.test(sql),
        `expected a strict "kickoff > NOW()" WHERE clause, got:\n${sql}`,
    );
});

test('buildTargetsQuery applies both CORRELATION_GUARDS (CAP-WASTE, SQL-side binding)', () => {
    const kx = knex({ client: 'mysql2' });
    const sql = buildTargetsQuery(kx).toSQL().sql;
    for (const guard of CORRELATION_GUARDS) {
        assert.ok(sql.includes(guard), `expected the compiled SQL to include guard: ${guard}\ngot:\n${sql}`);
    }
});

// --- Finding 1 (FINAL REVIEW): the rolling-stats aggregates are keyed on
// team id, not name - buildTargetsQuery must select both, or _buildStats
// (src/enrich.js) has no way to look a fixture's teams up in the bulk
// history map loadTeamHistory (src/hotpicks.js) returns.
test('buildTargetsQuery selects home_team_id/away_team_id (Finding 1: the rolling-stats loader needs them)', () => {
    const kx = knex({ client: 'mysql2' });
    const sql = buildTargetsQuery(kx).toSQL().sql;
    assert.ok(sql.includes('`f`.`home_team_id`'), `expected home_team_id to be selected, got:\n${sql}`);
    assert.ok(sql.includes('`f`.`away_team_id`'), `expected away_team_id to be selected, got:\n${sql}`);
});

// --- Finding 3 (FINAL REVIEW): dead settings control ------------------------
// OPENROUTER_MODEL/AI_BLIND_MODEL/AI_ANCHORED_MODEL are catalog live:true
// entries, but resolveTask/callModel used to always read the raw immutable
// `config` object - an admin override was a PERMANENT no-op. effectiveAiConfig
// is the fix: it must actually layer whatever its overrides source returns on
// top of config, and resolveTask must pick that up. `overridesFn` is injected
// (mirrors buildTargetsQuery's `knex` DI) so this is assertable fully offline,
// without touching settings.js's real DB-backed cache.
test('effectiveAiConfig layers an injected override over config defaults, and resolveTask honours it (Finding 3, dead-control fix)', () => {
    const cfg = effectiveAiConfig(() => ({ OPENROUTER_MODEL: 'openai/gpt-9-override' }));
    assert.equal(cfg.OPENROUTER_MODEL, 'openai/gpt-9-override');
    assert.equal(resolveTask('blind', cfg).model, 'openai/gpt-9-override');
    // every non-overridden key still falls back to the real config default
    assert.equal(cfg.AI_ENRICH_CAP, config.AI_ENRICH_CAP);
});

test('effectiveAiConfig defaults to settings.effectiveConfig() (offline-safe: no cache loaded -> config defaults)', () => {
    const cfg = effectiveAiConfig();
    assert.equal(cfg.OPENROUTER_MODEL, config.OPENROUTER_MODEL);
    assert.equal(cfg.AI_ENRICH_CAP, config.AI_ENRICH_CAP);
});

// --- Finding 4 (FINAL REVIEW): no API-key preflight -------------------------
// With one provider's key missing, every fixture used to bill the grounded
// Gemini facts call then throw on the blind call - anchored-with-no-blind on
// EVERY fixture, at full Gemini cost. assertAiProvidersConfigured is the
// fail-fast fix; it takes already-resolved booleans (never reaches into
// config/.env itself) so the assertion is testable without this machine's
// real GEMINI_API_KEY/OPENROUTER_API_KEY influencing the result.
test('assertAiProvidersConfigured throws naming GEMINI_API_KEY when the grounded provider is unconfigured', () => {
    assert.throws(
        () => assertAiProvidersConfigured({ geminiEnabled: false, openrouterEnabled: true }),
        /GEMINI_API_KEY/,
    );
});

test('assertAiProvidersConfigured throws naming OPENROUTER_API_KEY when the blind provider is unconfigured', () => {
    assert.throws(
        () => assertAiProvidersConfigured({ geminiEnabled: true, openrouterEnabled: false }),
        /OPENROUTER_API_KEY/,
    );
});

test('assertAiProvidersConfigured passes silently when both providers are configured', () => {
    assert.doesNotThrow(() => assertAiProvidersConfigured({ geminiEnabled: true, openrouterEnabled: true }));
});
