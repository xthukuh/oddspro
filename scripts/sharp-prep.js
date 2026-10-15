// Sharp-bets research, step 1 of 2 (2026-10-15): fold the read-only live
// extract (tmp/sharp/*.tsv.gz, produced on the host by a SELECT-only script)
// into one compact record per settled, linked fixture: tmp/sharp/fx.ndjson.
//
// Hindsight discipline, enforced here so no experiment can leak:
// - a price row last updated AT or AFTER the canonical kickoff is dropped
//   (its pre-match value is unknowable, the in-play value is hindsight);
// - a bookmaker listing whose sides are reversed against the canonical
//   fixture (matches.sides_swapped) is dropped, since its 1/2-type keys would
//   settle against the wrong team;
// - simulated competitions (matches.is_virtual) are dropped.
// The menu is built by the PRODUCTION pure modules (buildTipBooks +
// marketMenu), so every replay number is in the engine's own vocabulary.
//
// Usage: node scripts/sharp-prep.js [dir=tmp/sharp]
import { createReadStream, createWriteStream } from 'node:fs';
import { createGunzip } from 'node:zlib';
import readline from 'node:readline';
import path from 'node:path';
import { canonicalMarket } from '../src/markets.js';
import { buildTipBooks } from '../src/db/tip-rules.js';
import { marketMenu } from '../src/db/ladder-rules.js';

const DIR = process.argv[2] ?? 'tmp/sharp';

// mariadb -B escaping: NULL literal, backslash escapes for \t \n \\ \0.
const _unesc = s => (s === 'NULL' ? null : s.includes('\\')
    ? s.replace(/\\(.)/g, (_, c) => (c === 't' ? '\t' : c === 'n' ? '\n' : c === '0' ? '\0' : c))
    : s);

async function* tsv(file, { header = true, columns = null } = {}) {
    const rl = readline.createInterface({ input: createReadStream(path.join(DIR, file)).pipe(createGunzip()), crlfDelay: Infinity });
    let cols = columns;
    for await (const line of rl) {
        if (!line) continue;
        const parts = line.split('\t').map(_unesc);
        if (!cols) { cols = parts; if (header) continue; }
        const o = {};
        for (let i = 0; i < cols.length; i++) o[cols[i]] = parts[i];
        yield o;
    }
}

const _SIMPLE = new Set(['1', 'X', '2', '1X', 'X2', '12', 'GG', 'NG', 'DNB1', 'DNB2', 'ODD', 'EVEN']);
const _OU = /^[OU] \d+\.5$/;
const _up = s => String(s ?? '').trim().toUpperCase();

// Same key resolution as buildTipBooks' provider bag (tip-rules.js), kept
// here only to pre-filter rows and to record per-provider prices.
function bookKeyOf(row, H, A, memo) {
    const mk = `${row.type_name}\u0001${row.name}\u0001${row.handicap}\u0001${row.type_id}`;
    let desc = memo.get(mk);
    if (desc === undefined) {
        try { desc = canonicalMarket(row); } catch { desc = null; }
        memo.set(mk, desc);
    }
    if (!desc || desc.period != null) return null;
    if (_SIMPLE.has(desc.key) || _OU.test(desc.key)) return desc.key;
    if (desc.group === 'team_total') {
        const side = desc.tt?.side === 'home' ? 'H' : desc.tt?.side === 'away' ? 'A'
            : desc.tt?.team && _up(desc.tt.team) === H ? 'H'
                : desc.tt?.team && _up(desc.tt.team) === A ? 'A' : null;
        const ou = desc.key.startsWith('TT:') ? desc.key.slice(3) : null;
        if (side && ou && _OU.test(ou)) return `TT:${side}:${ou}`;
    }
    return null;
}

const t0 = Date.now();
const teams = new Map();
for await (const r of tsv('teams.tsv.gz')) teams.set(r.id, r.name);
const leagues = new Map();
for await (const r of tsv('leagues.tsv.gz')) leagues.set(r.id, { name: r.name, country: r.country });

const FINAL = new Set(['FT', 'AET', 'PEN']);
const fixtures = new Map();
for await (const r of tsv('fixtures.tsv.gz')) {
    if (!FINAL.has(r.status) || r.ft_home == null) continue;
    fixtures.set(r.id, r);
}

const matches = new Map();   // match id -> { provider, fixture_id }
const dropped = { swapped: 0, virtual: 0, notFinal: 0 };
for await (const r of tsv('matches.tsv.gz')) {
    if (!fixtures.has(r.fixture_id)) { dropped.notFinal++; continue; }
    if (r.sides_swapped === '1') { dropped.swapped++; continue; }
    if (r.is_virtual === '1') { dropped.virtual++; continue; }
    matches.set(r.id, { provider: r.provider, fixture_id: r.fixture_id });
}

const ODDS_COLS = ['match_id', 'type_id', 'type_name', 'name', 'handicap', 'price', 'is_stale', 'upd_vs_ko_min', 'crt_vs_ko_min'];
const perFixture = new Map();
const memo = new Map();
const stat = { rows: 0, kept: 0, postKickoff: 0, unknownMatch: 0, offMenu: 0 };
const updHist = {};
for await (const r of tsv('odds.tsv.gz', { header: false, columns: ODDS_COLS })) {
    if (r.match_id === 'match_id') continue;   // stray header guard
    stat.rows++;
    const m = matches.get(r.match_id);
    if (!m) { stat.unknownMatch++; continue; }
    const upd = Number(r.upd_vs_ko_min);
    if (!(upd < 0)) { stat.postKickoff++; continue; }
    const f = fixtures.get(m.fixture_id);
    const H = _up(teams.get(f.home_team_id)), A = _up(teams.get(f.away_team_id));
    const row = { provider: m.provider, type_id: r.type_id, type_name: r.type_name, name: r.name, handicap: r.handicap, price: r.price };
    const key = bookKeyOf(row, H, A, memo);
    if (!key) { stat.offMenu++; continue; }
    stat.kept++;
    const b = upd > -60 ? '<1h' : upd > -180 ? '1-3h' : upd > -1440 ? '3-24h' : '>24h';
    updHist[b] = (updHist[b] ?? 0) + 1;
    let fx = perFixture.get(m.fixture_id);
    if (!fx) perFixture.set(m.fixture_id, fx = { rows: [], prov: {}, upd: {} });
    fx.rows.push(row);
    const bag = (fx.prov[m.provider] ??= {});
    const p = Number(row.price);
    if (bag[key] == null || p < bag[key]) bag[key] = p;
    fx.upd[m.provider] = Math.max(fx.upd[m.provider] ?? -1e9, upd);
}

// BetPawa's own per-price win probability (the input its Win Bonus uses),
// keyed like the provider bag; the probability of the LOWEST-priced row per
// key wins, matching the bag's lowest-price fold.
const PROB_COLS = ['match_id', 'type_name', 'name', 'handicap', 'price', 'probability'];
const bpq = new Map();   // fixture_id -> { key: [price, prob] }
let probRows = 0;
try {
    for await (const r of tsv('prob.tsv.gz', { header: false, columns: PROB_COLS })) {
        const m = matches.get(r.match_id);
        if (!m || m.provider !== 'betpawa' || r.probability == null) continue;
        const f = fixtures.get(m.fixture_id);
        const key = bookKeyOf({ ...r, provider: 'betpawa', type_id: null }, _up(teams.get(f.home_team_id)), _up(teams.get(f.away_team_id)), memo);
        if (!key) continue;
        probRows++;
        let o = bpq.get(m.fixture_id);
        if (!o) bpq.set(m.fixture_id, o = {});
        const p = Number(r.price);
        if (!o[key] || p < o[key][0]) o[key] = [p, Number(r.probability)];
    }
} catch (e) {
    if (e.code !== 'ENOENT') throw e;
}

const out = createWriteStream(path.join(DIR, 'fx.ndjson'));
let written = 0;
for (const [id, fx] of perFixture) {
    const f = fixtures.get(id);
    const homeName = teams.get(f.home_team_id), awayName = teams.get(f.away_team_id);
    const books = buildTipBooks(fx.rows, { homeName, awayName });
    const menu = Object.fromEntries(Object.entries(marketMenu(books))
        .filter(([, l]) => Number(l.price) > 1 && l.prob != null)
        .map(([k, l]) => [k, [l.price, l.prob]]));
    const lg = leagues.get(f.league_id) ?? {};
    out.write(JSON.stringify({
        id: Number(id), day: f.kickoff.slice(0, 10), ko: f.kickoff,
        lid: Number(f.league_id), league: lg.name ?? null, country: lg.country ?? null,
        h: Number(f.home_team_id), a: Number(f.away_team_id), hn: homeName, an: awayName,
        ft: [Number(f.ft_home), Number(f.ft_away)],
        ht: f.ht_home == null ? null : [Number(f.ht_home), Number(f.ht_away)],
        menu, prov: fx.prov, upd: fx.upd,
        bpq: Object.fromEntries(Object.entries(bpq.get(id) ?? {}).map(([k, [, q]]) => [k, q])),
    }) + '\n');
    written++;
}
await new Promise(r => out.end(r));
console.log(JSON.stringify({ fixturesFinal: fixtures.size, matchesKept: matches.size, dropped, odds: stat, updHist, probRows, written, secs: (Date.now() - t0) / 1000 }, null, 1));
