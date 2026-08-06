// Calibration audit: empirical price -> outcome relationship over the FULL
// warehouse of finished fixtures with locked pre-match bookmaker prices.
// READ-ONLY. Engine-independent (never touches fixture_predictions/_prematch).
//
//   node scripts/research/calibration-audit.js
//
// Outputs: markdown-ish tables on stdout + full JSON at tmp/calibration-audit.json
import fs from 'node:fs';
import path from 'node:path';
import knex from 'knex';
import knexConfig from '../../knexfile.js';
import { canonicalMarket } from '../../src/markets.js';
import { tipOutcome } from '../../src/db/tip-rules.js';

// The FULL warehouse lives in the `oddspro` schema (the checked-out branch's
// .env points at the fresh `oddspro-stage`); override the database only.
// DB_NAME=... node scripts/research/calibration-audit.js to point elsewhere.
const DB_NAME = process.env.DB_NAME || 'oddspro';
const db = knex({
    ...knexConfig,
    connection: { ...knexConfig.connection, database: DB_NAME },
});
const closeDb = () => db.destroy();

const FINAL = ['FT', 'AET', 'PEN', 'AWD', 'WO'];
const CHUNK = 200;              // fixtures per odds query
const BOOT_B = 1000;            // bootstrap resamples
const BOOT_MIN_N = 30;          // below this fall back to Wilson
const UNDERPOWERED_N = 200;

// Price buckets [lo, hi)
const BUCKETS = [
    [1.00, 1.10], [1.10, 1.20], [1.20, 1.30], [1.30, 1.50],
    [1.50, 2.00], [2.00, 3.00], [3.00, 5.00], [5.00, Infinity],
];
const bucketOf = p => {
    for (let i = 0; i < BUCKETS.length; i++) if (p >= BUCKETS[i][0] && p < BUCKETS[i][1]) return i;
    return null; // p < 1 excluded upstream anyway
};
const bucketLabel = i => BUCKETS[i][1] === Infinity ? `${BUCKETS[i][0].toFixed(2)}+`
    : `${BUCKETS[i][0].toFixed(2)}-${BUCKETS[i][1].toFixed(2)}`;

// Family membership for devig books + reporting groups
const X12 = ['1', 'X', '2'];
const DC = ['1X', 'X2', '12'];
const OU_RE = /^([OU]) (\d+\.5)$/;
const TT_RE = /^TT:([HA]):([OU]) (\d+\.5)$/;
const SIMPLE = new Set([...X12, ...DC, 'GG', 'NG', 'DNB1', 'DNB2', 'ODD', 'EVEN']);

function groupOf(key) {
    if (X12.includes(key)) return '1X2';
    if (DC.includes(key)) return 'DC';
    if (OU_RE.test(key)) return 'OU';
    if (key === 'GG' || key === 'NG') return 'BTTS';
    if (key === 'DNB1' || key === 'DNB2') return 'DNB';
    if (key === 'ODD' || key === 'EVEN') return 'ODDEVEN';
    if (TT_RE.test(key)) return 'TT';
    return null;
}

// Family book id for devigging: which co-members close the book
function bookMembers(key) {
    if (X12.includes(key)) return X12;
    if (DC.includes(key)) return DC;
    const ou = OU_RE.exec(key);
    if (ou) return [`O ${ou[2]}`, `U ${ou[2]}`];
    if (key === 'GG' || key === 'NG') return ['GG', 'NG'];
    if (key === 'DNB1' || key === 'DNB2') return ['DNB1', 'DNB2'];
    if (key === 'ODD' || key === 'EVEN') return ['ODD', 'EVEN'];
    const tt = TT_RE.exec(key);
    if (tt) return [`TT:${tt[1]}:O ${tt[3]}`, `TT:${tt[1]}:U ${tt[3]}`];
    return null;
}

const _upper = s => String(s ?? '').trim().toUpperCase();

// Resolve an odds row to a settleable full-time market key ('1','O 2.5','TT:H:O 1.5',...)
function resolveKey(row, H, A) {
    const desc = canonicalMarket(row);
    if (desc.period != null) return null;                       // full-time only
    if (SIMPLE.has(desc.key) || OU_RE.test(`${desc.key}`) && /^[OU] /.test(desc.key)) return desc.key;
    if (OU_RE.test(desc.key)) return desc.key;
    if (desc.group === 'team_total') {
        const side = desc.tt?.side === 'home' ? 'H'
            : desc.tt?.side === 'away' ? 'A'
                : desc.tt?.team && _upper(desc.tt.team) === H ? 'H'
                    : desc.tt?.team && _upper(desc.tt.team) === A ? 'A'
                        : null;
        const ouKey = desc.key.startsWith('TT:') ? desc.key.slice(3) : null;
        if (side && ouKey && /^[OU] \d+\.5$/.test(ouKey)) return `TT:${side}:${ouKey}`;
    }
    return null;
}

// ---------- accumulators ----------------------------------------------------
// cells: Map cellKey -> Map day -> {n, hits, voids, imp, raw, price, profit}
// cellKey = `${variant}|${dim}|${key}|${bucket}` ; dim = 'key' | 'group' | 'ALL'
const cells = new Map();
function acc(variant, dim, key, bucket, day, obs) {
    const ck = `${variant}|${dim}|${key}|${bucket}`;
    let byDay = cells.get(ck);
    if (!byDay) cells.set(ck, byDay = new Map());
    let a = byDay.get(day);
    if (!a) byDay.set(day, a = { n: 0, hits: 0, voids: 0, imp: 0, raw: 0, price: 0, profit: 0 });
    if (obs.outcome === 'void') { a.voids++; return; }
    a.n++;
    if (obs.outcome === 'hit') { a.hits++; a.profit += obs.price - 1; } else a.profit -= 1;
    a.imp += obs.imp; a.raw += obs.raw; a.price += obs.price;
}

// weekly stability: Map `${key}|${week}` -> {n,hits,imp}
const weekly = new Map();
const WEEKLY_KEYS = new Set(['1', 'X', '2', '1X', 'X2', '12', 'O 2.5', 'U 2.5', 'GG', 'NG']);
function accWeek(key, week, obs) {
    if (!WEEKLY_KEYS.has(key) || obs.outcome === 'void') return;
    const k = `${key}|${week}`;
    let a = weekly.get(k);
    if (!a) weekly.set(k, a = { n: 0, hits: 0, imp: 0 });
    a.n++; a.imp += obs.imp; if (obs.outcome === 'hit') a.hits++;
}

// stale sensitivity: group-level, pooled, two variants
const staleSens = new Map(); // `${variant}|${group}` -> {n,hits,imp,profit}
function accStale(variant, group, obs) {
    if (obs.outcome === 'void') return;
    const k = `${variant}|${group}`;
    let a = staleSens.get(k);
    if (!a) staleSens.set(k, a = { n: 0, hits: 0, imp: 0, profit: 0 });
    a.n++; a.imp += obs.imp;
    if (obs.outcome === 'hit') { a.hits++; a.profit += obs.price - 1; } else a.profit -= 1;
}

// counters
const stats = {
    fixturesFinished: 0, fixturesWithOdds: 0, oddsRows: 0, mapped: 0,
    noBook: 0, staleRows: 0, unresolvedTT: 0, settleErrors: 0, observations: 0,
    minDay: null, maxDay: null,
};

// ---------- math helpers ----------------------------------------------------
function mulberry32(seed) {
    let t = seed >>> 0;
    return () => {
        t += 0x6D2B79F5;
        let r = Math.imul(t ^ (t >>> 15), 1 | t);
        r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
        return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
}

function wilson(hits, n, z = 1.96) {
    if (!n) return [null, null];
    const p = hits / n, z2 = z * z;
    const den = 1 + z2 / n;
    const c = (p + z2 / (2 * n)) / den;
    const half = (z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n))) / den;
    return [c - half, c + half];
}

// Day-clustered bootstrap CI over edge = hitRate - meanImplied
function bootEdgeCI(byDay, rng, B = BOOT_B) {
    const days = [...byDay.values()].filter(d => d.n > 0);
    if (days.length < 2) return null;
    const D = days.length;
    const samples = new Array(B);
    for (let b = 0; b < B; b++) {
        let n = 0, hits = 0, imp = 0;
        for (let i = 0; i < D; i++) {
            const d = days[(rng() * D) | 0];
            n += d.n; hits += d.hits; imp += d.imp;
        }
        samples[b] = n ? hits / n - imp / n : 0;
    }
    samples.sort((x, y) => x - y);
    return [samples[Math.floor(B * 0.025)], samples[Math.ceil(B * 0.975) - 1]];
}

function summarizeCell(byDay, { dayFilter = null } = {}) {
    let n = 0, hits = 0, voids = 0, imp = 0, raw = 0, price = 0, profit = 0;
    for (const [day, a] of byDay) {
        if (dayFilter && !dayFilter(day)) continue;
        n += a.n; hits += a.hits; voids += a.voids;
        imp += a.imp; raw += a.raw; price += a.price; profit += a.profit;
    }
    return {
        n, hits, voids,
        hit_rate: n ? hits / n : null,
        avg_price: n ? price / n : null,
        implied_devig: n ? imp / n : null,
        implied_raw: n ? raw / n : null,
        edge: n ? hits / n - imp / n : null,
        edge_raw: n ? hits / n - raw / n : null,
        roi: n ? profit / n : null,
    };
}

// ---------- main -------------------------------------------------------------
async function main() {
    const t0 = Date.now();
    const fixtures = await db('fixtures as f')
        .join('teams as th', 'th.id', 'f.home_team_id')
        .join('teams as ta', 'ta.id', 'f.away_team_id')
        .whereIn('f.status', FINAL)
        .whereNotNull('f.ft_home').whereNotNull('f.ft_away')
        .whereRaw('EXISTS (SELECT 1 FROM matches m WHERE m.fixture_id = f.id)')
        .select('f.id', 'f.ft_home', 'f.ft_away',
            db.raw("DATE_FORMAT(f.kickoff, '%Y-%m-%d') as day"),
            db.raw("DATE_FORMAT(f.kickoff, '%x-W%v') as week"),
            'th.name as home_name', 'ta.name as away_name')
        .orderBy('f.kickoff');
    stats.fixturesFinished = fixtures.length;
    console.error(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${fixtures.length} finished linked fixtures`);

    const byId = new Map(fixtures.map(f => [f.id, f]));
    const ids = fixtures.map(f => f.id);

    for (let off = 0; off < ids.length; off += CHUNK) {
        const chunk = ids.slice(off, off + CHUNK);
        const rows = await db('matches as m')
            .join('fixtures as f', 'f.id', 'm.fixture_id')
            .join('odds_markets as om', 'om.match_id', 'm.id')
            .whereIn('m.fixture_id', chunk)
            .where('om.price', '>', 1)
            .whereRaw('om.updated_at <= f.kickoff')
            .select('m.fixture_id', 'm.provider', 'om.type_name', 'om.name',
                'om.handicap', 'om.price', 'om.is_stale', 'om.updated_at');
        stats.oddsRows += rows.length;

        // group per fixture
        const byFixture = new Map();
        for (const r of rows) {
            let g = byFixture.get(r.fixture_id);
            if (!g) byFixture.set(r.fixture_id, g = []);
            g.push(r);
        }

        for (const [fid, frows] of byFixture) {
            const f = byId.get(fid);
            const H = _upper(f.home_name), A = _upper(f.away_name);
            // last pre-kickoff snapshot per (provider, key): max updated_at, tie -> lowest price
            // fresh (non-stale) primary; stale-inclusive kept separately
            const fresh = new Map(); // `${provider}|${key}` -> {price, up}
            const withStale = new Map();
            for (const r of frows) {
                const key = resolveKey(r, H, A);
                if (!key) {
                    if (canonicalMarket(r).group === 'team_total' && canonicalMarket(r).period == null) stats.unresolvedTT++;
                    continue;
                }
                stats.mapped++;
                const price = Number(r.price);
                if (!(price > 1)) continue;
                const up = +new Date(r.updated_at);
                const slot = `${r.provider}|${key}`;
                const put = (map) => {
                    const cur = map.get(slot);
                    if (!cur || up > cur.up || (up === cur.up && price < cur.price)) {
                        map.set(slot, { provider: r.provider, key, price, up });
                    }
                };
                put(withStale);
                if (!r.is_stale) put(fresh); else stats.staleRows++;
            }
            if (!fresh.size && !withStale.size) continue;
            stats.fixturesWithOdds++;
            if (!stats.minDay || f.day < stats.minDay) stats.minDay = f.day;
            if (!stats.maxDay || f.day > stats.maxDay) stats.maxDay = f.day;

            const settle = key => {
                try { return tipOutcome(key, f.ft_home, f.ft_away); }
                catch { stats.settleErrors++; return null; }
            };

            // build per-provider price bags for devig
            const process = (map, primary) => {
                const bags = {}; // provider -> {key: price}
                for (const { provider, key, price } of map.values()) {
                    (bags[provider] ??= {})[key] = price;
                }
                const bestRows = new Map(); // key -> obs with max price (devig-complete only)
                for (const [provider, bag] of Object.entries(bags)) {
                    for (const [key, price] of Object.entries(bag)) {
                        const members = bookMembers(key);
                        const complete = members && members.every(k => bag[k] > 1);
                        const outcome = settle(key);
                        if (!outcome) continue;
                        if (!complete) { if (primary) stats.noBook++; continue; }
                        const ov = members.reduce((s, k) => s + 1 / bag[k], 0);
                        // Fair-total of the book: 1X2 and every two-way book sum to 1;
                        // double chance outcomes each cover 2 of 3 results -> fair total 2.
                        const fairTotal = DC.includes(key) ? 2 : 1;
                        const imp = Math.min(1, fairTotal * (1 / price) / ov);
                        const obs = { outcome, price, imp, raw: 1 / price };
                        const grp = groupOf(key);
                        if (!primary) { accStale('with_stale', grp, obs); continue; }
                        accStale('fresh', grp, obs);
                        const b = bucketOf(price);
                        stats.observations++;
                        for (const variant of ['pooled', provider]) {
                            acc(variant, 'key', key, b, f.day, obs);
                            acc(variant, 'group', grp, b, f.day, obs);
                            acc(variant, 'ALL', 'ALL', b, f.day, obs);
                        }
                        accWeek(key, f.week, obs);
                        const cur = bestRows.get(key);
                        if (!cur || price > cur.price) bestRows.set(key, obs);
                    }
                }
                if (primary) {
                    for (const [key, obs] of bestRows) {
                        const b = bucketOf(obs.price);
                        acc('best', 'key', key, b, f.day, obs);
                        acc('best', 'group', groupOf(key), b, f.day, obs);
                        acc('best', 'ALL', 'ALL', b, f.day, obs);
                    }
                }
            };
            process(fresh, true);
            process(withStale, false);
        }
        if ((off / CHUNK) % 10 === 0) {
            console.error(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${Math.min(off + CHUNK, ids.length)}/${ids.length} fixtures, ${stats.oddsRows} odds rows, ${stats.observations} observations`);
        }
    }
    console.error(`[${((Date.now() - t0) / 1000).toFixed(1)}s] accumulation done; computing stats over ${cells.size} cells`);

    // ---------- summarize -----------------------------------------------------
    const rng = mulberry32(20260804);
    const allDays = [...new Set([...cells.values()].flatMap(m => [...m.keys()]))].sort();
    const splitIdx = Math.ceil(allDays.length * 0.6);
    const trainDays = new Set(allDays.slice(0, splitIdx));
    const trainMax = allDays[splitIdx - 1];

    const out = [];
    for (const [ck, byDay] of cells) {
        const [variant, dim, key, bucket] = ck.split('|');
        const s = summarizeCell(byDay);
        if (!s.n) continue;
        let ci = null, ciMethod = null;
        if (s.n >= BOOT_MIN_N && byDay.size >= 2) {
            ci = bootEdgeCI(byDay, rng);
            ciMethod = 'boot';
        }
        if (!ci) {
            const [lo, hi] = wilson(s.hits, s.n);
            ci = lo == null ? null : [lo - s.implied_devig, hi - s.implied_devig];
            ciMethod = 'wilson';
        }
        const train = summarizeCell(byDay, { dayFilter: d => trainDays.has(d) });
        const test = summarizeCell(byDay, { dayFilter: d => !trainDays.has(d) });
        out.push({
            variant, dim, key, bucket: +bucket, bucket_label: bucketLabel(+bucket),
            ...s, ci_lo: ci?.[0] ?? null, ci_hi: ci?.[1] ?? null, ci_method: ciMethod,
            days: byDay.size, underpowered: s.n < UNDERPOWERED_N,
            train: { n: train.n, edge: train.edge, hit: train.hit_rate, roi: train.roi },
            test: { n: test.n, edge: test.edge, hit: test.hit_rate, roi: test.roi },
        });
    }

    const weeklyOut = [...weekly.entries()].map(([k, a]) => {
        const [key, week] = k.split('|');
        return { key, week, n: a.n, hit: a.hits / a.n, implied: a.imp / a.n, edge: a.hits / a.n - a.imp / a.n };
    }).sort((x, y) => x.week < y.week ? -1 : x.week > y.week ? 1 : x.key < y.key ? -1 : 1);

    const staleOut = [...staleSens.entries()].map(([k, a]) => {
        const [variant, group] = k.split('|');
        return { variant, group, n: a.n, hit: a.hits / a.n, implied: a.imp / a.n, edge: a.hits / a.n - a.imp / a.n, roi: a.profit / a.n };
    });

    const result = {
        generated: new Date().toISOString(),
        stats, buckets: BUCKETS.map((_, i) => bucketLabel(i)),
        days: { total: allDays.length, first: allDays[0], last: allDays[allDays.length - 1], train_last: trainMax, train_days: splitIdx, test_days: allDays.length - splitIdx },
        cells: out, weekly: weeklyOut, stale: staleOut,
    };
    fs.mkdirSync(path.resolve('tmp'), { recursive: true });
    fs.writeFileSync(path.resolve('tmp/calibration-audit.json'), JSON.stringify(result, null, 1));
    console.error(`[${((Date.now() - t0) / 1000).toFixed(1)}s] wrote tmp/calibration-audit.json`);

    // ---------- print tables --------------------------------------------------
    const fmt = (v, d = 3) => v == null ? '-' : (+v).toFixed(d);
    const pct = v => v == null ? '-' : (100 * v).toFixed(1) + '%';
    const line = c => console.log(c);

    line(`# Calibration audit  (${stats.minDay} .. ${stats.maxDay})`);
    line(`fixtures finished+linked: ${stats.fixturesFinished}; with usable pre-match odds: ${stats.fixturesWithOdds}`);
    line(`odds rows scanned: ${stats.oddsRows}; primary observations (fresh, devig-complete): ${stats.observations}; incomplete-book drops: ${stats.noBook}; stale rows: ${stats.staleRows}; unresolved TT: ${stats.unresolvedTT}; settle errors: ${stats.settleErrors}`);
    line(`days: ${allDays.length} (train ${splitIdx} thru ${trainMax}, test ${allDays.length - splitIdx})`);
    line('');

    const printTable = (variant, dim, filterKey = null) => {
        const rows = out.filter(c => c.variant === variant && c.dim === dim && (!filterKey || c.key === filterKey))
            .sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : a.bucket - b.bucket);
        if (!rows.length) return;
        line(`\n## ${variant} / ${dim}${filterKey ? ' / ' + filterKey : ''}`);
        line('| key | bucket | n | days | hit | avg price | implied(devig) | implied(raw) | edge | edge CI95 | roi | flag |');
        line('|---|---|---|---|---|---|---|---|---|---|---|---|');
        for (const c of rows) {
            line(`| ${c.key} | ${c.bucket_label} | ${c.n} | ${c.days} | ${pct(c.hit_rate)} | ${fmt(c.avg_price, 2)} | ${pct(c.implied_devig)} | ${pct(c.implied_raw)} | ${pct(c.edge)} | [${pct(c.ci_lo)}, ${pct(c.ci_hi)}]${c.ci_method === 'wilson' ? '*' : ''} | ${pct(c.roi)} | ${c.underpowered ? 'UNDERPOWERED' : ''} |`);
        }
    };

    for (const v of ['pooled', 'betpawa', 'betika', 'best']) {
        printTable(v, 'ALL');
        printTable(v, 'group');
    }
    printTable('pooled', 'key');
    printTable('best', 'key');

    // positive-edge candidates
    line('\n## Positive-edge candidates (CI excludes 0 on the positive side, any variant/dim)');
    line('| variant | dim | key | bucket | n | edge | CI95 | roi | train edge (n) | test edge (n) | sign survives |');
    line('|---|---|---|---|---|---|---|---|---|---|---|');
    const cands = out.filter(c => c.ci_lo != null && c.ci_lo > 0).sort((a, b) => b.n - a.n);
    for (const c of cands) {
        const survives = c.test.n > 0 && c.test.edge != null && c.test.edge > 0;
        line(`| ${c.variant} | ${c.dim} | ${c.key} | ${c.bucket_label} | ${c.n} | ${pct(c.edge)} | [${pct(c.ci_lo)}, ${pct(c.ci_hi)}]${c.ci_method === 'wilson' ? '*' : ''} | ${pct(c.roi)} | ${pct(c.train.edge)} (${c.train.n}) | ${pct(c.test.edge)} (${c.test.n}) | ${survives ? 'YES' : 'no'} |`);
    }
    if (!cands.length) line('| (none) | | | | | | | | | | |');

    // weekly stability
    line('\n## Weekly calibration (biggest keys)');
    line('| week | key | n | hit | implied | edge |');
    line('|---|---|---|---|---|---|');
    for (const w of weeklyOut) if (w.n >= 50) line(`| ${w.week} | ${w.key} | ${w.n} | ${pct(w.hit)} | ${pct(w.implied)} | ${pct(w.edge)} |`);

    // stale sensitivity
    line('\n## Stale-row sensitivity (pooled, group level)');
    line('| group | variant | n | hit | implied | edge | roi |');
    line('|---|---|---|---|---|---|---|');
    for (const s of staleOut.sort((a, b) => a.group < b.group ? -1 : 1)) {
        line(`| ${s.group} | ${s.variant} | ${s.n} | ${pct(s.hit)} | ${pct(s.implied)} | ${pct(s.edge)} | ${pct(s.roi)} |`);
    }

    // monotonicity breaks (adjacent buckets, both n>=200, hit rises with price)
    line('\n## Monotonicity breaks (pooled/key: hit rate INCREASES as price rises, adjacent buckets both n>=200)');
    line('| key | bucket A | hitA | bucket B | hitB | nA | nB |');
    line('|---|---|---|---|---|---|---|');
    const byKey = new Map();
    for (const c of out.filter(c => c.variant === 'pooled' && c.dim === 'key')) {
        (byKey.get(c.key) ?? byKey.set(c.key, []).get(c.key)).push(c);
    }
    let breaks = 0;
    for (const [key, arr] of byKey) {
        arr.sort((a, b) => a.bucket - b.bucket);
        for (let i = 1; i < arr.length; i++) {
            const a = arr[i - 1], b = arr[i];
            if (a.n >= UNDERPOWERED_N && b.n >= UNDERPOWERED_N && b.hit_rate > a.hit_rate) {
                line(`| ${key} | ${a.bucket_label} | ${pct(a.hit_rate)} | ${b.bucket_label} | ${pct(b.hit_rate)} | ${a.n} | ${b.n} |`);
                breaks++;
            }
        }
    }
    if (!breaks) line('| (none) | | | | | | |');

    console.error(`[${((Date.now() - t0) / 1000).toFixed(1)}s] done`);
}

main().then(() => closeDb()).catch(async e => { console.error(e); await closeDb(); process.exitCode = 1; });
