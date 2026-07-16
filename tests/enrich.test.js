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
import { buildTargetsQuery } from '../src/enrich.js';
import { KICKOFF_SQL_EXPR, CORRELATION_GUARDS } from '../src/db/ai-rules.js';

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
