// structure-mine.js - cross-market STRUCTURE mine over the bookmaker odds menu.
//
// Hypothesis space: a bookmaker's ENTIRE pre-match menu for a fixture (which
// markets are offered, at what prices, with what internal shape) encodes the
// bookmaker's risk assessment; cross-market structure may carry categorization
// signal beyond any single price.
//
// Method: per finished linked fixture, build features from the odds menu ONLY
// (never from this repo's prediction tables), then test whether each feature
// separates realized outcomes of standard target bets WITHIN price bands
// (edge = realized − devigged-implied). Temporal train/test split on whole
// kickoff days (first 60% / last 40%); Wilson CIs per cell; day-clustered
// bootstrap CIs (seeded PRNG) on the screened candidate deltas.
//
// READ-ONLY on the database. Reproducible:  node scripts/research/structure-mine.js
// DB: the main warehouse `oddspro` by default (the .env DB_DATABASE points at a
// near-empty staging copy); override with RESEARCH_DB=<name>.
import knex from 'knex';
import knexConfig from '../../knexfile.js';
import { canonicalMarket } from '../../src/markets.js';
import { tipOutcome } from '../../src/db/tip-rules.js';

const DB_NAME = process.env.RESEARCH_DB || 'oddspro';
const db = knex({ ...knexConfig, connection: { ...knexConfig.connection, database: DB_NAME } });

const FINAL_STATUSES = ['FT', 'AET', 'PEN', 'AWD', 'WO'];
const CHUNK = 200;                 // fixtures per odds pull
const BANDS = [
    { label: '<=1.10', lo: 1.0, hi: 1.10 },
    { label: '1.10-1.25', lo: 1.10, hi: 1.25 },
    { label: '1.25-1.50', lo: 1.25, hi: 1.50 },
    { label: '1.50-2.00', lo: 1.50, hi: 2.00 },
    { label: '>2.00', lo: 2.00, hi: Infinity },
];
const TRAIN_FRACTION = 0.6;        // of distinct kickoff days
const BOOT_ITERS = 1000;
const BOOT_SEED = 20260804;
const SCREEN_MIN_N = 100;          // per side, train, to become a candidate
const SCREEN_MIN_DELTA = 0.03;     // |edge_on − edge_off| in train
const UNDERPOWERED_N = 200;

// ---------- small stats helpers ----------
const sum = a => a.reduce((s, v) => s + v, 0);
const mean = a => (a.length ? sum(a) / a.length : null);
function median(a) {
    if (!a.length) return null;
    const s = [...a].sort((x, y) => x - y);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
// Wilson 95% interval for a binomial proportion.
function wilson(hits, n) {
    if (!n) return [null, null];
    const z = 1.96, p = hits / n, z2 = z * z;
    const den = 1 + z2 / n;
    const centre = (p + z2 / (2 * n)) / den;
    const half = (z / den) * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n));
    return [centre - half, centre + half];
}
// Seeded PRNG (mulberry32) so the bootstrap cannot be re-rolled until it looks good.
function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
const fmt = (v, d = 3) => (v == null || Number.isNaN(v) ? ' - ' : (+v).toFixed(d));
const pct = (v, d = 1) => (v == null || Number.isNaN(v) ? ' - ' : (100 * v).toFixed(d) + '%');

// ---------- menu assembly ----------
const normName = s => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');

function newMenu() {
    return {
        rows: 0, keysFT: new Set(), keysAll: new Set(), minPrice: Infinity,
        below120: 0,
        x12: {}, dc: {}, ou: {}, btts: {}, dnb: {}, oe: {}, tt: { H: {}, A: {} },
        ftPrices: new Map(), // canonical FT key -> price (cross-provider divergence)
    };
}

// Feed one odds row into a provider menu. `homeN`/`awayN` are normalized team names.
function addRow(menu, row, homeN, awayN) {
    const price = Number(row.price);
    if (!(price > 1)) return;
    const cm = canonicalMarket(row);
    menu.rows++;
    menu.keysAll.add(cm.key);
    if (price < menu.minPrice) menu.minPrice = price;
    if (price < 1.20) menu.below120++;
    if (cm.period) return; // families below are FULL TIME only
    menu.keysFT.add(cm.key);

    if (cm.group === 'result') menu.x12[cm.key] = price;
    else if (cm.group === 'double_chance') menu.dc[cm.key] = price;
    else if (cm.group === 'over_under') {
        const m = /^([OU]) (\d+\.5)$/.exec(cm.key);
        if (m) { (menu.ou[m[2]] ||= {})[m[1]] = price; }
    } else if (cm.group === 'btts') menu.btts[cm.key] = price;
    else if (cm.group === 'dnb') menu.dnb[cm.key] = price;
    else if (cm.group === 'odd_even') menu.oe[cm.key] = price;
    else if (cm.group === 'team_total' && cm.tt) {
        const m = /^TT:([OU]) (\d+\.5)$/.exec(cm.key);
        if (m) {
            let side = cm.tt.side === 'home' ? 'H' : cm.tt.side === 'away' ? 'A' : null;
            if (!side && cm.tt.team) {
                const t = normName(cm.tt.team);
                if (t && homeN && (t === homeN || homeN.includes(t) || t.includes(homeN))) side = 'H';
                else if (t && awayN && (t === awayN || awayN.includes(t) || t.includes(awayN))) side = 'A';
            }
            if (side) (menu.tt[side][m[2]] ||= {})[m[1]] = price;
        }
    }
    // cross-provider comparable price per canonical FT key (first seen wins; the
    // store keeps one live row per market so duplicates are rare)
    if (!menu.ftPrices.has(cm.key)) menu.ftPrices.set(cm.key, price);
}

// Devig a complete family book: { key: price } -> { key: implied } (proportional).
// `mass` = what the TRUE outcome probabilities sum to across the book's legs:
// 1 for partitions of the outcome space (1X2, O/U pair, BTTS, odd/even, TT pair,
// DNB - conditional on no-draw, consistent with excluding voids from the
// denominator), 2 for double chance (the three DC legs double-cover the space - 
// naive mass-1 devig halves every DC implied and fabricates a +33% "edge").
function devig(book, keys, mass = 1) {
    for (const k of keys) if (!(Number(book[k]) > 1)) return null;
    const inv = keys.map(k => 1 / Number(book[k]));
    const s = sum(inv);
    const out = {};
    keys.forEach((k, i) => { out[k] = mass * inv[i] / s; });
    out._overround = s / mass;
    return out;
}

// Prefer the betpawa book when complete, else betika (mirrors selectFamilyBook order).
function pickBook(menus, family, keys, mass = 1) {
    for (const prov of ['betpawa', 'betika']) {
        const m = menus[prov];
        if (!m) continue;
        const d = devig(m[family], keys, mass);
        if (d) return { prov, prices: m[family], implied: d };
    }
    return null;
}

// ---------- per-fixture feature + target extraction ----------
function buildFixtureRecord(fx, menus) {
    const rec = { id: fx.id, day: fx.day, league_id: fx.league_id, fh: fx.fh, fa: fx.fa, features: {}, targets: [] };
    const F = rec.features;

    const provs = Object.keys(menus);
    rec.providers = provs.length;

    // --- family books (fixture level, provider-pure) ---
    const x12 = pickBook(menus, 'x12', ['1', 'X', '2']);
    const dc = pickBook(menus, 'dc', ['1X', 'X2', '12'], 2);
    const btts = pickBook(menus, 'btts', ['GG', 'NG']);
    const dnb = pickBook(menus, 'dnb', ['DNB1', 'DNB2']);
    const oe = pickBook(menus, 'oe', ['ODD', 'EVEN']);
    const ouBooks = {}; // line -> {prov, prices:{O,U}, implied}
    for (const prov of ['betpawa', 'betika']) {
        const m = menus[prov];
        if (!m) continue;
        for (const [line, pair] of Object.entries(m.ou)) {
            if (ouBooks[line]) continue;
            const d = devig(pair, ['O', 'U']);
            if (d) ouBooks[line] = { prov, prices: pair, implied: d };
        }
    }
    const ttBooks = { H: {}, A: {} };
    for (const prov of ['betpawa', 'betika']) {
        const m = menus[prov];
        if (!m) continue;
        for (const side of ['H', 'A']) {
            for (const [line, pair] of Object.entries(m.tt[side])) {
                if (ttBooks[side][line]) continue;
                const d = devig(pair, ['O', 'U']);
                if (d) ttBooks[side][line] = { prov, prices: pair, implied: d };
            }
        }
    }

    // --- F1: 1X2 allocation shape ---
    if (x12) {
        const { implied, prices } = x12;
        F.fav_is_home = implied['1'] >= implied['2'];
        const favKey = F.fav_is_home ? '1' : '2';
        const dogKey = F.fav_is_home ? '2' : '1';
        F.fav_gap = implied[favKey] - implied[dogKey];
        F.draw_p = implied.X;
        F.fav_price = Number(prices[favKey]);
        F.fav_implied = implied[favKey];
        F.min_x12_price = Math.min(...['1', 'X', '2'].map(k => Number(prices[k])));
        F.ovr_x12 = implied._overround;
        rec.targets.push({ name: 'FAV', key: favKey, price: F.fav_price, implied: implied[favKey] });
    }
    if (dc) F.ovr_dc = dc.implied._overround;

    // --- F3: O/U ladder shape ---
    const lines = Object.keys(ouBooks).map(Number).sort((a, b) => a - b);
    if (lines.length) {
        F.ou_lines = lines.length;
        // expected-goals proxy: the line where devigged pOver crosses 0.5
        const pts = lines.map(l => ({ l, p: ouBooks[String(l)].implied.O }));
        let cross = null;
        for (let i = 0; i < pts.length - 1; i++) {
            const a = pts[i], b = pts[i + 1];
            if (a.p >= 0.5 && b.p <= 0.5 && a.p !== b.p) { cross = a.l + (a.p - 0.5) * (b.l - a.l) / (a.p - b.p); break; }
        }
        if (cross == null) cross = pts[0].p < 0.5 ? pts[0].l : pts[pts.length - 1].l;
        F.xg_cross = cross;
        if (pts.length >= 2) F.ou_slope = (pts[0].p - pts[pts.length - 1].p) / (pts[pts.length - 1].l - pts[0].l);
    }
    const ou25 = ouBooks['2.5'], ou15 = ouBooks['1.5'], ou45 = ouBooks['4.5'], ou35 = ouBooks['3.5'], ou05 = ouBooks['0.5'];
    if (ou25) {
        F.o25_price = Number(ou25.prices.O);
        F.ovr_ou25 = ou25.implied._overround;
        rec.targets.push({ name: 'O 2.5', key: 'O 2.5', price: F.o25_price, implied: ou25.implied.O });
    }
    if (ou15) rec.targets.push({ name: 'O 1.5', key: 'O 1.5', price: Number(ou15.prices.O), implied: ou15.implied.O });
    if (ou45) rec.targets.push({ name: 'U 4.5', key: 'U 4.5', price: Number(ou45.prices.U), implied: ou45.implied.U });
    if (ou05) rec.targets.push({ name: 'O 0.5', key: 'O 0.5', price: Number(ou05.prices.O), implied: ou05.implied.O });
    if (ou35) {
        F.o35_price = Number(ou35.prices.O);
        rec.targets.push({ name: 'U 3.5', key: 'U 3.5', price: Number(ou35.prices.U), implied: ou35.implied.U });
    }
    F.goalrich = F.o25_price != null ? F.o25_price <= 1.60 : (F.o35_price != null ? F.o35_price <= 2.20 : null);
    F.blowout = F.fav_price != null ? F.fav_price < 1.20 : null;

    // --- F2: extremity over the whole menu ---
    let minPrice = Infinity, below120 = 0, rows = 0;
    const keysFT = new Set(), keysAll = new Set();
    for (const prov of provs) {
        const m = menus[prov];
        rows += m.rows;
        below120 += m.below120;
        if (m.minPrice < minPrice) minPrice = m.minPrice;
        for (const k of m.keysFT) keysFT.add(k);
        for (const k of m.keysAll) keysAll.add(k);
    }
    if (rows) {
        F.menu_min_price = minPrice;
        F.n_below_120 = below120;
        F.menu_keys_ft = keysFT.size;
        F.menu_keys_all = keysAll.size;
    }

    // --- F4: breadth / exotics ---
    F.has_btts = Boolean(btts);
    F.has_dnb = Boolean(dnb);
    F.has_oe = Boolean(oe);
    F.has_tt = Boolean(Object.keys(ttBooks.H).length || Object.keys(ttBooks.A).length);
    if (btts) F.ovr_btts = btts.implied._overround;
    if (dnb) F.ovr_dnb = dnb.implied._overround;

    // --- F5: cross-family coherence ---
    if (x12 && dnb) {
        const favByX12 = x12.implied['1'] >= x12.implied['2'] ? 'DNB1' : 'DNB2';
        const favByDnb = dnb.implied.DNB1 >= dnb.implied.DNB2 ? 'DNB1' : 'DNB2';
        F.dnb_agree = favByX12 === favByDnb;
    }
    const th = ttBooks.H['1.5'], ta = ttBooks.A['1.5'];
    if (th && ta) F.tt_asym = Math.abs(Math.log(Number(ta.prices.O) / Number(th.prices.O)));
    if (btts && ou25) F.btts_ou_gap = Math.abs(btts.implied.GG - ou25.implied.O);

    // --- F6: cross-provider divergence ---
    if (menus.betpawa && menus.betika) {
        const a = menus.betpawa.ftPrices, b = menus.betika.ftPrices;
        const diffs = [];
        for (const [k, pa] of a) {
            const pb = b.get(k);
            if (pb) diffs.push(Math.abs(Math.log(pa / pb)));
        }
        if (diffs.length >= 5) F.xprov_diverge = mean(diffs);
        F.xprov_menu_ratio = Math.min(menus.betpawa.keysAll.size, menus.betika.keysAll.size)
            / Math.max(menus.betpawa.keysAll.size, menus.betika.keysAll.size);
    }

    // --- SHORT target: shortest-priced leg across all devig-able family books ---
    let short = null;
    const consider = (key, price, implied) => {
        price = Number(price);
        if (price > 1 && (!short || price < short.price)) short = { name: 'SHORT', key, price, implied };
    };
    if (x12) for (const k of ['1', 'X', '2']) consider(k, x12.prices[k], x12.implied[k]);
    if (dc) for (const k of ['1X', 'X2', '12']) consider(k, dc.prices[k], dc.implied[k]);
    if (btts) for (const k of ['GG', 'NG']) consider(k, btts.prices[k], btts.implied[k]);
    if (dnb) for (const k of ['DNB1', 'DNB2']) consider(k, dnb.prices[k], dnb.implied[k]);
    if (oe) for (const k of ['ODD', 'EVEN']) consider(k, oe.prices[k], oe.implied[k]);
    for (const [line, bk] of Object.entries(ouBooks)) {
        consider(`O ${line}`, bk.prices.O, bk.implied.O);
        consider(`U ${line}`, bk.prices.U, bk.implied.U);
    }
    for (const side of ['H', 'A']) {
        for (const [line, bk] of Object.entries(ttBooks[side])) {
            consider(`TT:${side}:O ${line}`, bk.prices.O, bk.implied.O);
            consider(`TT:${side}:U ${line}`, bk.prices.U, bk.implied.U);
        }
    }
    if (short) rec.targets.push(short);

    // settle every target (skip unknown keys and voids)
    rec.targets = rec.targets.map(t => {
        try {
            const out = tipOutcome(t.key, fx.fh, fx.fa);
            if (out === 'void') return null;
            return { ...t, hit: out === 'hit' ? 1 : 0 };
        } catch { return null; }
    }).filter(Boolean);

    // family-book legs for H-margin (per-family overround vs calibration).
    // NOTE: within one complete book the pooled all-legs edge is ZERO by
    // construction (implieds sum to the mass, exactly `mass` legs hit), so the
    // H-margin section reports the FAVOURITE leg's edge + the Brier score
    // instead - those are not degenerate. `fav` marks the book's shortest leg.
    rec.marginLegs = [];
    const legFam = (fam, bk, settleKeys) => {
        if (!bk) return;
        const keys = Object.keys(settleKeys);
        const maxImp = Math.max(...keys.map(k => bk.implied[k]));
        for (const k of keys) {
            try {
                const out = tipOutcome(settleKeys[k], fx.fh, fx.fa);
                if (out === 'void') continue;
                rec.marginLegs.push({
                    fam, overround: bk.implied._overround, implied: bk.implied[k],
                    hit: out === 'hit' ? 1 : 0, fav: bk.implied[k] === maxImp,
                });
            } catch { /* skip */ }
        }
    };
    legFam('1X2', x12, { 1: '1', X: 'X', 2: '2' });
    legFam('DC', dc, { '1X': '1X', X2: 'X2', 12: '12' });
    legFam('OU2.5', ou25, { O: 'O 2.5', U: 'U 2.5' });
    legFam('BTTS', btts, { GG: 'GG', NG: 'NG' });

    // --- H-bait leg collection ---
    // (a) cross-provider generosity: for every settleable leg present in BOTH
    //     providers' complete family books, g = log(own price / other price);
    //     the "bait" reading is that unusually generous legs realize worse than
    //     their own-book devigged implied.
    // (b) anomalous overround: every leg of every complete single-provider
    //     family book, carrying the book's normalized overround.
    rec.baitLegs = [];
    rec.bookLegs = [];
    const provBooks = {};
    for (const prov of provs) {
        const m = menus[prov];
        const legs = {};
        const addFam = (fam, book, keys, settleMap = null, mass = 1) => {
            if (!book) return;
            const d = devig(book, keys, mass);
            if (!d) return;
            for (const k of keys) {
                const settleKey = settleMap ? settleMap[k] : k;
                legs[settleKey] = { price: Number(book[k]), implied: d[k], ovr: d._overround, fam };
            }
        };
        addFam('1X2', m.x12, ['1', 'X', '2']);
        addFam('DC', m.dc, ['1X', 'X2', '12'], null, 2);
        for (const [line, pair] of Object.entries(m.ou)) addFam('OU', pair, ['O', 'U'], { O: `O ${line}`, U: `U ${line}` });
        addFam('BTTS', m.btts, ['GG', 'NG']);
        addFam('DNB', m.dnb, ['DNB1', 'DNB2']);
        addFam('OE', m.oe, ['ODD', 'EVEN']);
        for (const side of ['H', 'A']) {
            for (const [line, pair] of Object.entries(m.tt[side])) {
                addFam('TT', pair, ['O', 'U'], { O: `TT:${side}:O ${line}`, U: `TT:${side}:U ${line}` });
            }
        }
        provBooks[prov] = legs;
    }
    for (const [prov, legs] of Object.entries(provBooks)) {
        const other = provBooks[prov === 'betpawa' ? 'betika' : 'betpawa'];
        for (const [key, leg] of Object.entries(legs)) {
            let out;
            try { out = tipOutcome(key, fx.fh, fx.fa); } catch { continue; }
            if (out === 'void') continue;
            const hit = out === 'hit' ? 1 : 0;
            rec.bookLegs.push({ prov, key, fam: leg.fam, price: leg.price, implied: leg.implied, ovr: leg.ovr, hit });
            const o = other?.[key];
            if (o) rec.baitLegs.push({ prov, key, fam: leg.fam, price: leg.price, implied: leg.implied, g: Math.log(leg.price / o.price), hit });
        }
    }

    return rec;
}

// ---------- load ----------
console.log(`# structure-mine - DB \`${DB_NAME}\` - ${new Date().toISOString()}`);
const t0 = Date.now();

const fixtures = await db.raw(`
    SELECT f.id, f.league_id, DATE_FORMAT(f.kickoff, '%Y-%m-%d') day,
           f.ft_home fh, f.ft_away fa
    FROM fixtures f
    WHERE f.status IN (${FINAL_STATUSES.map(() => '?').join(',')})
      AND f.ft_home IS NOT NULL AND f.ft_away IS NOT NULL
      AND EXISTS (SELECT 1 FROM matches m WHERE m.fixture_id = f.id)
    ORDER BY f.kickoff
`, FINAL_STATUSES).then(([r]) => r);
console.log(`Finished linked fixtures: ${fixtures.length}; days ${fixtures[0]?.day} .. ${fixtures[fixtures.length - 1]?.day}`);

const matchRows = await db.raw(`
    SELECT m.id, m.provider, m.fixture_id, m.home_team_name, m.away_team_name
    FROM matches m WHERE m.fixture_id IS NOT NULL
`).then(([r]) => r);
const matchesByFixture = new Map();
for (const m of matchRows) {
    if (!matchesByFixture.has(m.fixture_id)) matchesByFixture.set(m.fixture_id, []);
    matchesByFixture.get(m.fixture_id).push(m);
}

const records = [];
for (let i = 0; i < fixtures.length; i += CHUNK) {
    const chunk = fixtures.slice(i, i + CHUNK);
    const ids = chunk.map(f => f.id);
    const odds = await db.raw(`
        SELECT o.match_id, o.type_name, o.name, o.handicap, o.price
        FROM odds_markets o
        JOIN matches m ON m.id = o.match_id
        JOIN fixtures f ON f.id = m.fixture_id
        WHERE m.fixture_id IN (${ids.map(() => '?').join(',')})
          AND o.is_stale = 0 AND o.price > 1
          AND o.updated_at <= f.kickoff
    `, ids).then(([r]) => r);
    const byMatch = new Map();
    for (const row of odds) {
        if (!byMatch.has(row.match_id)) byMatch.set(row.match_id, []);
        byMatch.get(row.match_id).push(row);
    }
    for (const fx of chunk) {
        const menus = {};
        for (const m of matchesByFixture.get(fx.id) || []) {
            const rows = byMatch.get(m.id);
            if (!rows || !rows.length) continue;
            const menu = (menus[m.provider] ||= newMenu());
            const homeN = normName(m.home_team_name), awayN = normName(m.away_team_name);
            for (const row of rows) addRow(menu, row, homeN, awayN);
        }
        if (!Object.keys(menus).length) continue;
        records.push(buildFixtureRecord(fx, menus));
    }
    process.stderr.write(`\rprocessed ${Math.min(i + CHUNK, fixtures.length)}/${fixtures.length} fixtures`);
}
process.stderr.write('\n');
console.log(`Fixtures with a usable pre-match menu: ${records.length} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);

// league popularity proxy (within the analyzed set - menu-derived context, not repo predictions)
const leagueCount = new Map();
for (const r of records) leagueCount.set(r.league_id, (leagueCount.get(r.league_id) || 0) + 1);
for (const r of records) r.features.league_pop = leagueCount.get(r.league_id);

// ---------- temporal split ----------
const days = [...new Set(records.map(r => r.day))].sort();
const trainDays = new Set(days.slice(0, Math.ceil(days.length * TRAIN_FRACTION)));
const testDays = new Set(days.filter(d => !trainDays.has(d)));
console.log(`Days: ${days.length} total; train ${trainDays.size} (${days[0]}..${[...trainDays].sort().pop()}), test ${testDays.size} (..${days[days.length - 1]})`);

// ---------- feature definitions (binarized) ----------
// Continuous features split at the TRAIN median (no test leakage).
const CONTINUOUS = [
    ['fav_gap', 'F1 fav−dog devigged gap high'],
    ['draw_p', 'F1 draw probability high'],
    ['menu_min_price', 'F2 shortest menu price LOW'],
    ['n_below_120', 'F2 count of prices <1.20 high'],
    ['xg_cross', 'F3 O/U 2.0-cross (xG proxy) high'],
    ['o35_price', 'F3 O 3.5 price SHORT (low)'],
    ['ou_lines', 'F3 O/U ladder depth high'],
    ['menu_keys_ft', 'F4 FT menu breadth high'],
    ['menu_keys_all', 'F4 total menu breadth high'],
    ['ovr_x12', 'F4 1X2 overround high'],
    ['ovr_ou25', 'F4 O/U 2.5 overround high'],
    ['ovr_btts', 'F4 BTTS overround high'],
    ['tt_asym', 'F5 team-total asymmetry high'],
    ['btts_ou_gap', 'F5 BTTS↔O2.5 incoherence high'],
    ['xprov_diverge', 'F6 cross-provider price divergence high'],
    ['xprov_menu_ratio', 'F6 cross-provider menu-size similarity high'],
    ['league_pop', 'F7 league popularity high'],
];
// For features where LOW is the interesting side, flip so "on" = interesting.
const FLIP = new Set(['menu_min_price', 'o35_price']);
const BOOLEAN = [
    ['fav_is_home', 'F1 favourite is the home side'],
    ['has_tt', 'F4 team totals offered'],
    ['has_oe', 'F4 odd/even offered'],
    ['has_btts', 'F4 BTTS offered'],
    ['dnb_agree', 'F5 DNB agrees with 1X2 favourite'],
    ['goalrich', 'H-goalrich: O2.5<=1.60 (or O3.5<=2.20)'],
    ['blowout', 'H-blowout: 1X2 favourite < 1.20'],
];

const thresholds = {};
for (const [f] of CONTINUOUS) {
    const vals = records.filter(r => trainDays.has(r.day) && r.features[f] != null && Number.isFinite(r.features[f]))
        .map(r => r.features[f]);
    thresholds[f] = median(vals);
}
function featureOn(rec, f) {
    const v = rec.features[f];
    if (v == null) return null;
    if (typeof v === 'boolean') return v;
    const t = thresholds[f];
    if (t == null || !Number.isFinite(v)) return null;
    return FLIP.has(f) ? v <= t : v >= t;
}

// ---------- target row assembly ----------
const TARGETS = ['FAV', 'O 1.5', 'O 2.5', 'U 4.5', 'SHORT'];
const targetRows = new Map(TARGETS.map(t => [t, []]));
for (const r of records) {
    for (const t of r.targets) {
        if (!targetRows.has(t.name)) continue;
        targetRows.get(t.name).push({ day: r.day, rec: r, price: t.price, implied: t.implied, hit: t.hit, key: t.key });
    }
}
console.log('\nTarget populations: ' + TARGETS.map(t => `${t}=${targetRows.get(t).length}`).join('  '));

const bandOf = p => BANDS.find(b => p > b.lo && p <= b.hi) || (p <= 1.10 ? BANDS[0] : BANDS[4]);

function cellStats(rows) {
    const n = rows.length;
    if (!n) return { n: 0 };
    const hits = sum(rows.map(r => r.hit));
    const imp = mean(rows.map(r => r.implied));
    const rate = hits / n;
    const [lo, hi] = wilson(hits, n);
    return { n, rate, implied: imp, edge: rate - imp, edgeLo: lo - imp, edgeHi: hi - imp };
}

// day-clustered bootstrap CI for delta = edge_on − edge_off
function bootDelta(rowsOn, rowsOff, iters, seed) {
    const rng = mulberry32(seed);
    const byDayOn = new Map(), byDayOff = new Map();
    for (const r of rowsOn) { if (!byDayOn.has(r.day)) byDayOn.set(r.day, []); byDayOn.get(r.day).push(r); }
    for (const r of rowsOff) { if (!byDayOff.has(r.day)) byDayOff.set(r.day, []); byDayOff.get(r.day).push(r); }
    const allDays = [...new Set([...byDayOn.keys(), ...byDayOff.keys()])];
    const deltas = [];
    for (let i = 0; i < iters; i++) {
        const on = [], off = [];
        for (let j = 0; j < allDays.length; j++) {
            const d = allDays[Math.floor(rng() * allDays.length)];
            if (byDayOn.has(d)) on.push(...byDayOn.get(d));
            if (byDayOff.has(d)) off.push(...byDayOff.get(d));
        }
        if (!on.length || !off.length) continue;
        const eOn = mean(on.map(r => r.hit)) - mean(on.map(r => r.implied));
        const eOff = mean(off.map(r => r.hit)) - mean(off.map(r => r.implied));
        deltas.push(eOn - eOff);
    }
    deltas.sort((a, b) => a - b);
    if (deltas.length < 100) return [null, null];
    return [deltas[Math.floor(deltas.length * 0.025)], deltas[Math.floor(deltas.length * 0.975)]];
}

// ---------- the sweep ----------
const ALL_FEATURES = [...CONTINUOUS, ...BOOLEAN];
let testsRun = 0;
const candidates = [];

console.log('\n## Within-band edge tables (edge = realized − devigged implied)');
console.log('Feature ON/OFF per fixture; continuous features split at the TRAIN median.');
console.log(`Cells with n < ${UNDERPOWERED_N} on either side are UNDERPOWERED (flagged *).`);

for (const target of TARGETS) {
    const rows = targetRows.get(target);
    console.log(`\n### Target ${target} (${rows.length} settled rows)`);
    for (const [f, label] of ALL_FEATURES) {
        const withF = rows.map(r => ({ ...r, on: featureOn(r.rec, f) })).filter(r => r.on != null);
        if (!withF.length) continue;
        const lines = [];
        for (const band of BANDS) {
            const inBand = withF.filter(r => bandOf(r.price) === band);
            const on = inBand.filter(r => r.on), off = inBand.filter(r => !r.on);
            if (on.length < 30 || off.length < 30) continue; // hopeless cells: skip printing
            testsRun++;
            const sOn = cellStats(on), sOff = cellStats(off);
            const delta = sOn.edge - sOff.edge;
            const under = (on.length < UNDERPOWERED_N || off.length < UNDERPOWERED_N) ? '*' : ' ';
            lines.push(`  ${band.label.padEnd(9)} on n=${String(sOn.n).padStart(4)} edge=${pct(sOn.edge).padStart(7)} [${pct(sOn.edgeLo)},${pct(sOn.edgeHi)}] | off n=${String(sOff.n).padStart(4)} edge=${pct(sOff.edge).padStart(7)} [${pct(sOff.edgeLo)},${pct(sOff.edgeHi)}] | Δ=${pct(delta).padStart(7)}${under}`);
            // screening on TRAIN
            const trOn = on.filter(r => trainDays.has(r.day)), trOff = off.filter(r => trainDays.has(r.day));
            const teOn = on.filter(r => testDays.has(r.day)), teOff = off.filter(r => testDays.has(r.day));
            if (trOn.length >= SCREEN_MIN_N && trOff.length >= SCREEN_MIN_N) {
                const eTrOn = cellStats(trOn), eTrOff = cellStats(trOff);
                const dTr = eTrOn.edge - eTrOff.edge;
                if (Math.abs(dTr) >= SCREEN_MIN_DELTA) {
                    const eTeOn = cellStats(teOn), eTeOff = cellStats(teOff);
                    const dTe = (teOn.length && teOff.length) ? eTeOn.edge - eTeOff.edge : null;
                    candidates.push({ target, feature: f, label, band: band.label, dTr, nTrOn: trOn.length, nTrOff: trOff.length, dTe, nTeOn: teOn.length, nTeOff: teOff.length, dAll: delta, on, off });
                }
            }
        }
        if (lines.length) {
            console.log(`\n- ${f} - ${label}${thresholds[f] != null ? ` (train median ${fmt(thresholds[f])})` : ''}`);
            for (const l of lines) console.log(l);
        }
    }
}
console.log(`\nTotal band-cells tested: ${testsRun} (expect ~${(testsRun / 20).toFixed(0)} spurious 95%-CI exclusions by chance alone)`);

// ---------- candidate survival table ----------
console.log('\n## Train→test survival of screened candidates');
console.log(`Screen: train |Δedge| >= ${pct(SCREEN_MIN_DELTA)} with n >= ${SCREEN_MIN_N}/side. Bootstrap: day-clustered, ${BOOT_ITERS} iters, seed ${BOOT_SEED}.`);
if (!candidates.length) console.log('No candidate cleared the screen.');
candidates.sort((a, b) => Math.abs(b.dTr) - Math.abs(a.dTr));
let seedIdx = 0;
for (const c of candidates) {
    const [bLo, bHi] = bootDelta(c.on, c.off, BOOT_ITERS, BOOT_SEED + (seedIdx++));
    const survived = c.dTe != null && Math.sign(c.dTe) === Math.sign(c.dTr) && Math.abs(c.dTe) >= SCREEN_MIN_DELTA / 2;
    c.bootLo = bLo; c.bootHi = bHi; c.survived = survived;
    console.log(`- ${c.target} × ${c.feature} @ ${c.band}: Δtrain=${pct(c.dTr)} (n=${c.nTrOn}/${c.nTrOff}) → Δtest=${c.dTe == null ? ' - ' : pct(c.dTe)} (n=${c.nTeOn}/${c.nTeOff}) | Δall=${pct(c.dAll)} bootCI=[${pct(bLo)},${pct(bHi)}] | ${survived ? 'SURVIVES' : 'fails'}${(bLo != null && bLo <= 0 && bHi >= 0) ? ' (CI spans 0)' : ''}`);
}

// ---------- H-blowout descriptive ----------
console.log('\n## H-blowout: extreme 1X2 favourites (price < 1.20) - totals behavior');
{
    const blow = records.filter(r => r.features.blowout === true);
    const rest = records.filter(r => r.features.blowout === false);
    const goals = rs => mean(rs.map(r => r.fh + r.fa));
    console.log(`fixtures: blowout=${blow.length}, other=${rest.length}; mean total goals ${fmt(goals(blow), 2)} vs ${fmt(goals(rest), 2)}`);
    for (const [key, name] of [['U 3.5', 'U 3.5'], ['U 4.5', 'U 4.5'], ['O 2.5', 'O 2.5']]) {
        const legs = [];
        for (const r of blow) {
            const t = r.targets.find(x => x.key === key);
            if (t) legs.push(t);
        }
        if (!legs.length) continue;
        const s = cellStats(legs);
        console.log(`  ${name}: n=${s.n} realized=${pct(s.rate)} implied=${pct(s.implied)} edge=${pct(s.edge)} [${pct(s.edgeLo)},${pct(s.edgeHi)}]`);
    }
}

// ---------- H-margin: family overround vs calibration ----------
console.log('\n## H-margin: family overround tercile vs calibration');
console.log('Pooled all-legs edge is 0 by construction (complete books), so the metrics are:');
console.log('favourite-leg edge (the book\'s shortest leg) and the all-legs Brier score.');
{
    const byFam = new Map();
    for (const r of records) for (const leg of r.marginLegs) {
        if (!byFam.has(leg.fam)) byFam.set(leg.fam, []);
        byFam.get(leg.fam).push({ ...leg, day: r.day });
    }
    for (const [fam, legs] of byFam) {
        const ovrs = legs.map(l => l.overround).sort((a, b) => a - b);
        const t1 = ovrs[Math.floor(ovrs.length / 3)], t2 = ovrs[Math.floor(2 * ovrs.length / 3)];
        const bucket = l => (l.overround <= t1 ? 'low' : l.overround <= t2 ? 'mid' : 'high');
        console.log(`- ${fam} (${legs.length} legs; overround terciles at ${fmt(t1)} / ${fmt(t2)})`);
        for (const b of ['low', 'mid', 'high']) {
            const sel = legs.filter(l => bucket(l) === b);
            const favLegs = sel.filter(l => l.fav);
            const s = cellStats(favLegs.map(l => ({ hit: l.hit, implied: l.implied })));
            const brier = mean(sel.map(l => (l.hit - l.implied) ** 2));
            const meanImp = mean(favLegs.map(l => l.implied));
            console.log(`    ${b.padEnd(4)} fav-leg n=${String(s.n).padStart(5)} implied=${pct(meanImp)} edge=${pct(s.edge).padStart(7)} [${pct(s.edgeLo)},${pct(s.edgeHi)}] | all-legs Brier=${fmt(brier, 4)} (n=${sel.length})`);
        }
    }
}

// ---------- H-bait (a): cross-provider generosity ----------
console.log('\n## H-bait (a): cross-provider generosity - does an unusually generous quote realize worse than its own-book implied?');
{
    const legs = [];
    for (const r of records) for (const l of r.baitLegs) legs.push({ ...l, day: r.day });
    const trainG = legs.filter(l => trainDays.has(l.day)).map(l => l.g).sort((a, b) => a - b);
    const q = p => trainG[Math.floor(trainG.length * p)];
    const q75 = q(0.75), q90 = q(0.90);
    console.log(`legs with a cross-provider counterpart: ${legs.length} (fixtures with both providers only); train g-quantiles: q75=${fmt(q75)} q90=${fmt(q90)} (g = log ownPrice/otherPrice)`);
    for (const [label, cut] of [['top-quartile generosity (g>=q75)', q75], ['top-decile generosity (g>=q90)', q90], ['extreme outlier generosity (g>=0.10, own price 10%+ over the other book)', 0.10]]) {
        console.log(`- ${label} vs rest:`);
        for (const band of BANDS) {
            const inBand = legs.filter(l => bandOf(l.price) === band);
            const on = inBand.filter(l => l.g >= cut), off = inBand.filter(l => l.g < cut);
            if (on.length < 30 || off.length < 30) continue;
            const sOn = cellStats(on), sOff = cellStats(off);
            const trOn = on.filter(l => trainDays.has(l.day)), trOff = off.filter(l => trainDays.has(l.day));
            const teOn = on.filter(l => testDays.has(l.day)), teOff = off.filter(l => testDays.has(l.day));
            const dTr = (trOn.length && trOff.length) ? cellStats(trOn).edge - cellStats(trOff).edge : null;
            const dTe = (teOn.length && teOff.length) ? cellStats(teOn).edge - cellStats(teOff).edge : null;
            const [bLo, bHi] = bootDelta(on, off, BOOT_ITERS, BOOT_SEED + 9001);
            const under = (on.length < UNDERPOWERED_N || off.length < UNDERPOWERED_N) ? '*' : ' ';
            console.log(`  ${band.label.padEnd(9)} gen n=${String(sOn.n).padStart(5)} edge=${pct(sOn.edge).padStart(7)} [${pct(sOn.edgeLo)},${pct(sOn.edgeHi)}] | rest n=${String(sOff.n).padStart(6)} edge=${pct(sOff.edge).padStart(7)} | Δ=${pct(sOn.edge - sOff.edge).padStart(7)}${under} (train Δ=${pct(dTr)}, test Δ=${pct(dTe)}, bootCI=[${pct(bLo)},${pct(bHi)}])`);
        }
    }
    // Realized EV at price for the generous legs - the bettor-facing bottom line.
    for (const [label, sel] of [['g>=q90 legs', legs.filter(l => l.g >= q90)], ['g>=0.10 legs', legs.filter(l => l.g >= 0.10)], ['all cross-provider legs', legs]]) {
        const ev = mean(sel.map(l => l.hit * l.price - 1));
        console.log(`  flat-stake EV at price, ${label}: ${pct(ev)} (n=${sel.length})`);
    }
}

// ---------- H-bait (b): anomalous overround books ----------
console.log('\n## H-bait (b): anomalous (boosted-looking) overround books - do they settle worse for the bettor?');
{
    const legs = [];
    for (const r of records) for (const l of r.bookLegs) legs.push({ ...l, day: r.day });
    const OVR_BUCKETS = [
        { label: '<1.02 (boosted-looking)', lo: 0, hi: 1.02 },
        { label: '1.02-1.05', lo: 1.02, hi: 1.05 },
        { label: '1.05-1.10 (normal)', lo: 1.05, hi: 1.10 },
        { label: '>=1.10 (heavy margin)', lo: 1.10, hi: Infinity },
    ];
    const bucketOf = l => OVR_BUCKETS.find(b => l.ovr >= b.lo && l.ovr < b.hi);
    console.log(`family-book legs (all complete single-provider books, voids excluded): ${legs.length}`);
    console.log('per normalized-overround bucket - mean edge (vs own devig), price-weighted excess EV, realized flat EV at price:');
    for (const b of OVR_BUCKETS) {
        const sel = legs.filter(l => bucketOf(l) === b);
        if (!sel.length) { console.log(`  ${b.label.padEnd(24)} n=0`); continue; }
        const s = cellStats(sel);
        const excess = mean(sel.map(l => l.price * (l.hit - l.implied)));
        const ev = mean(sel.map(l => l.hit * l.price - 1));
        const evExp = mean(sel.map(l => l.implied * l.price - 1));
        console.log(`  ${b.label.padEnd(24)} n=${String(s.n).padStart(6)} edge=${pct(s.edge).padStart(7)} [${pct(s.edgeLo)},${pct(s.edgeHi)}] excessEV=${pct(excess).padStart(7)} | realized EV=${pct(ev)} vs calib-expected EV=${pct(evExp)}`);
    }
    console.log('within price bands, boosted (<1.02) vs normal (1.05-1.10):');
    for (const band of BANDS) {
        const inBand = legs.filter(l => bandOf(l.price) === band);
        const on = inBand.filter(l => l.ovr < 1.02), off = inBand.filter(l => l.ovr >= 1.05 && l.ovr < 1.10);
        if (on.length < 30 || off.length < 30) { console.log(`  ${band.label.padEnd(9)} underpowered (boosted n=${on.length})`); continue; }
        const sOn = cellStats(on), sOff = cellStats(off);
        const trOn = on.filter(l => trainDays.has(l.day)), trOff = off.filter(l => trainDays.has(l.day));
        const teOn = on.filter(l => testDays.has(l.day)), teOff = off.filter(l => testDays.has(l.day));
        const dTr = (trOn.length && trOff.length) ? cellStats(trOn).edge - cellStats(trOff).edge : null;
        const dTe = (teOn.length && teOff.length) ? cellStats(teOn).edge - cellStats(teOff).edge : null;
        const [bLo, bHi] = bootDelta(on, off, BOOT_ITERS, BOOT_SEED + 9002);
        const under = (on.length < UNDERPOWERED_N || off.length < UNDERPOWERED_N) ? '*' : ' ';
        console.log(`  ${band.label.padEnd(9)} boosted n=${String(sOn.n).padStart(5)} edge=${pct(sOn.edge).padStart(7)} [${pct(sOn.edgeLo)},${pct(sOn.edgeHi)}] | normal n=${String(sOff.n).padStart(6)} edge=${pct(sOff.edge).padStart(7)} | Δ=${pct(sOn.edge - sOff.edge).padStart(7)}${under} (train Δ=${pct(dTr)}, test Δ=${pct(dTe)}, bootCI=[${pct(bLo)},${pct(bHi)}])`);
    }
}

console.log(`\nDone in ${((Date.now() - t0) / 1000).toFixed(0)}s. Hypotheses tested: ${ALL_FEATURES.length} features × ${TARGETS.length} targets across ${BANDS.length} price bands (${testsRun} populated cells) + H-blowout/H-margin/H-bait named blocks.`);
await db.destroy();
