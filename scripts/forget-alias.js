// Delete a learned alias, so a bad one is recoverable at all.
//
// Audit finding F3: `team_aliases` / `league_aliases` are taught by every
// confident link and then short-circuit the scorer for all future fixtures of
// those teams. There was no DELETE, no UPDATE, no override and no expiry
// anywhere in the repo, and scripts/lib/sync-rules.js classes both tables
// `canonical`, so a wrong entry replicated between local and live and was
// permanent. This is the missing escape hatch.
//
// Deleting an alias is safe by construction: it only removes a SHORTCUT. The
// next link pass re-derives the correlation by fuzzy scoring, which is what
// would have happened had the alias never been written. It does NOT unlink
// anything already linked (use scripts/repair-duplicate-claims.js or a manual
// fixture_id reset for that).
//
// Usage:
//   node scripts/forget-alias.js --list "annecy"              # search both tables
//   node scripts/forget-alias.js --team "FC Annecy"           # dry run
//   node scripts/forget-alias.js --team "FC Annecy" --yes
//   node scripts/forget-alias.js --league "U20 Paulista" --yes
//   node scripts/forget-alias.js --team "X" --provider betika --yes
//
// Matching is EXACT on alias_name (that is how the linker looks it up), except
// for --list which is a LIKE search to find the exact string to pass back in.

import { db, closeDb } from '../src/db/connection.js';

const args = process.argv.slice(2);
const val = f => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
const APPLY = args.includes('--yes');
const provider = val('--provider');
const search = val('--list');
const team = val('--team');
const league = val('--league');

async function list(term) {
    for (const [table, idCol, joinTable, nameCol] of [
        ['team_aliases', 'team_id', 'teams', 'name'],
        ['league_aliases', 'league_id', 'leagues', 'name'],
    ]) {
        const q = db(`${table} as a`)
            .join(`${joinTable} as t`, 't.id', `a.${idCol}`)
            .whereRaw('LOWER(a.alias_name) LIKE ?', [`%${String(term).toLowerCase()}%`])
            .select('a.provider', 'a.alias_name', `a.${idCol} as target_id`, `t.${nameCol} as target`)
            .orderBy('a.alias_name')
            .limit(40);
        if (provider) q.where('a.provider', provider);
        const rows = await q;
        console.log(`\n--- ${table}: ${rows.length} match(es)`);
        for (const r of rows) {
            console.log(`  [${r.provider}] "${r.alias_name}"  ->  ${r.target} (id ${r.target_id})`);
        }
    }
}

async function forget(table, idCol, joinTable, name) {
    const sel = db(`${table} as a`)
        .join(`${joinTable} as t`, 't.id', `a.${idCol}`)
        .where('a.alias_name', name)
        .select('a.provider', 'a.alias_name', `a.${idCol} as target_id`, 't.name as target');
    if (provider) sel.where('a.provider', provider);
    const rows = await sel;
    if (!rows.length) {
        console.log(`[forget] no ${table} entry with alias_name exactly "${name}"`
            + `${provider ? ` for provider ${provider}` : ''}.`);
        console.log('[forget] try --list to find the exact string.');
        return 0;
    }
    for (const r of rows) {
        console.log(`[forget] ${APPLY ? 'DELETING' : 'would delete'} [${r.provider}] `
            + `"${r.alias_name}" -> ${r.target} (id ${r.target_id})`);
    }
    if (!APPLY) return 0;
    const del = db(table).where('alias_name', name);
    if (provider) del.where('provider', provider);
    return del.del();
}

try {
    if (search) {
        await list(search);
    } else if (team) {
        const n = await forget('team_aliases', 'team_id', 'teams', team);
        console.log(`[forget] ${APPLY ? `deleted ${n} row(s).` : 'dry run - re-run with --yes to apply.'}`);
    } else if (league) {
        const n = await forget('league_aliases', 'league_id', 'leagues', league);
        console.log(`[forget] ${APPLY ? `deleted ${n} row(s).` : 'dry run - re-run with --yes to apply.'}`);
    } else {
        console.log('usage: node scripts/forget-alias.js (--list <term> | --team <name> | --league <name>) '
            + '[--provider betpawa|betika] [--yes]');
        process.exitCode = 1;
    }
} catch (e) {
    console.error('[forget] failed:', e);
    process.exitCode = 1;
} finally {
    await closeDb();
}
