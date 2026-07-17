// EDGE SENTINEL — the standing M4.3 instrument over fixture_ai_insights.
// READ-ONLY: no writes, no AI calls, no API-Football calls. Run it any time;
// it measures whatever has accumulated. ~seconds.
//
//   node scripts/edge-sentinel.js
//
// WHY. M4.2b (docs/research/m4.2b-booster-validation-and-value-edge.md) proved rolling
// stats carry ZERO information orthogonal to the devigged market price - the
// mechanistic reason no bettable edge exists on the current signal set. The
// one untested lever is the M4.1 AI enrichment (grounded facts + a blind
// non-Google reasoner + an anchored reasoner). This sentinel is
// probe-value-edge.js's methodology POINTED AT THE AI SIGNAL, plus the two
// measurements that need NO outcomes at all - so learning starts the day the
// faucet opens, not after ~1,800 rows:
//
//   M1 ANCHORING EFFECT (no outcomes needed): anchored - blind probability on
//      the same fixture+tip. Both reasoners saw byte-identical evidence
//      (ai-rules.js builds both prompts from one projection); the ONLY
//      asymmetry is that anchored also saw our tip and its price. A positive
//      mean = seeing the bet pulls the model toward the bet. First read ever.
//   M2 AI-MARKET DISSENT (no outcomes needed): blind_prob - devigged market
//      prob, per market. If the blind AI simply re-derives the market
//      (dissent ~ 0 everywhere), there is no orthogonal information to hope
//      for and M4.3 can be de-scoped early. If it dissents, M3 arbitrates.
//   M3 DISSENT CALIBRATION (needs settled fixtures; the slow-burn edge test):
//      does positive dissent predict (realized - devig) > 0? This is H-CALIB
//      from probe-value-edge.js with signal = blind AI instead of rolling
//      stats. Rolling stats scored FLAT NOISE here; if the AI's high-dissent
//      bin climbs, that is the first market-orthogonal signal this project
//      has ever seen - then and only then does an EV sweep make sense.
//      Reported with honest power labels (mine-rules MIN_TEST=40 floor as the
//      reference); day-clustered CI once >= 5 days of settled coverage exist.
//
// Honesty contract as everywhere: this file ships NO ranking change. A signal
// here is a candidate for a pre-registered OOS confirmation, never an
// insta-ship (src/db/mine-rules.js vocabulary governs).
import { writeFileSync, mkdirSync } from 'node:fs';
import { db, closeDb } from '../src/db/connection.js';
import { FINAL_STATUSES } from '../src/apisports.js';
import { marketKey } from '../src/markets.js';
import { BLIND_MARKETS } from '../src/db/ai-rules.js';
import { dayClusteredBootstrap, flatEv, hitRate, BETTABLE_FLOOR, MIN_TEST } from '../src/db/mine-rules.js';

const pct = v => (v == null ? ' n/a' : (100 * v).toFixed(1) + '%');
const pp = v => (v == null ? 'n/a' : (v >= 0 ? '+' : '') + (100 * v).toFixed(2) + 'pp');
const ev = v => (v == null ? 'n/a' : (v >= 0 ? '+' : '') + (100 * v).toFixed(1) + '%');
const _mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const _sd = a => { if (a.length < 2) return null; const m = _mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const _med = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const _json = v => { if (v == null) return null; if (typeof v === 'string') { try { return JSON.parse(v); } catch { return null; } } return v; };

// settle a BLIND_MARKET from a final score. true/false; null = not settleable.
function settle(market, h, a) {
    const tot = h + a;
    switch (market) {
        case '1': return h > a; case 'X': return h === a; case '2': return h < a;
        case 'O 2.5': return tot > 2.5; case 'U 2.5': return tot < 2.5;
        case 'GG': return h > 0 && a > 0; case 'NG': return !(h > 0 && a > 0);
        default: return null;
    }
}

const _devig = ps => { const inv = ps.map(p => (Number(p) > 1 ? 1 / Number(p) : null)); if (inv.some(v => v == null)) return null; const s = inv.reduce((a, b) => a + b, 0); return inv.map(v => v / s); };
function devigProb(mp, market) {
    const t = _devig([mp['1'], mp['X'], mp['2']]);
    if (['1', 'X', '2'].includes(market)) return t ? t[{ '1': 0, 'X': 1, '2': 2 }[market]] : null;
    if (market === 'O 2.5' || market === 'U 2.5') { const d = _devig([mp['O 2.5'], mp['U 2.5']]); return d ? d[market === 'O 2.5' ? 0 : 1] : null; }
    if (market === 'GG' || market === 'NG') { const d = _devig([mp['GG'], mp['NG']]); return d ? d[market === 'GG' ? 0 : 1] : null; }
    return null;
}

const BTTS_NAMES = new Set(['BOTH TEAMS TO SCORE (GG/NG)', 'Both Teams To Score | Full Time', 'Both Teams to Score | Full Time']);

try {
    // ---------- load insights + fixture state ----------
    const rows = await db('fixture_ai_insights as i')
        .join('fixtures as f', 'f.id', 'i.fixture_id')
        .select('i.fixture_id', 'i.kind', 'i.provider', 'i.model_tag', 'i.payload',
            'f.status', 'f.ft_home', 'f.ft_away',
            db.raw("DATE_FORMAT(f.kickoff,'%Y-%m-%d') as day"));
    const byFixture = new Map();
    for (const r of rows) {
        const e = byFixture.get(r.fixture_id) ?? { day: r.day, status: r.status, fh: r.ft_home, fa: r.ft_away };
        e[r.kind] = _json(r.payload);
        byFixture.set(r.fixture_id, e);
    }
    const fids = [...byFixture.keys()];
    const settledIds = fids.filter(id => { const e = byFixture.get(id); return FINAL_STATUSES.includes(e.status) && e.fh != null && e.fa != null; });
    console.log(`Enriched fixtures: ${fids.length} (blind ${fids.filter(id => byFixture.get(id).blind).length}, `
        + `anchored ${fids.filter(id => byFixture.get(id).anchored).length}, settled ${settledIds.length})`);

    // ---------- price attach (best fresh price per fixture+market) ----------
    const om = await db('matches as m')
        .join('odds_markets as om', 'om.match_id', 'm.id')
        .whereIn('m.fixture_id', fids).where('om.is_stale', 0)
        .select('m.fixture_id', 'om.type_name', 'om.name', 'om.handicap', 'om.price');
    const price = new Map();
    const bump = (fid, key, p) => { if (key == null || !(Number(p) > 1)) return; let mp = price.get(fid); if (!mp) price.set(fid, mp = {}); if (mp[key] == null || Number(p) > mp[key]) mp[key] = Number(p); };
    for (const r of om) {
        const k = marketKey(r); if (k) { bump(r.fixture_id, k, r.price); continue; }
        if (BTTS_NAMES.has(r.type_name)) { const nm = String(r.name).toLowerCase(); if (/^(gg|yes)/.test(nm)) bump(r.fixture_id, 'GG', r.price); else if (/^(ng|no)/.test(nm)) bump(r.fixture_id, 'NG', r.price); }
    }

    // ================= M1 — ANCHORING EFFECT (no outcomes) =================
    console.log('\n############ M1 — anchoring effect (anchored - blind, same fixture+tip) ############');
    const deltas = [], vsMkt = [];
    let pairable = 0, offMenu = 0;
    for (const id of fids) {
        const e = byFixture.get(id);
        const anch = e.anchored, blind = e.blind;
        if (!anch || !blind || anch.probability == null || !anch.tip?.market) continue;
        pairable++;
        const m = anch.tip.market;
        const bp = blind.probabilities?.[m];
        if (bp == null) { offMenu++; continue; }        // tip market outside BLIND_MARKETS
        const d = anch.probability - bp;
        deltas.push(d);
        const dv = price.has(id) ? devigProb(price.get(id), m) : null;
        if (dv != null) vsMkt.push({ anch: anch.probability - dv, blind: bp - dv });
    }
    if (deltas.length) {
        console.log(`  pairs with comparable market: ${deltas.length} (of ${pairable} anchored pairs; ${offMenu} tips outside the blind menu)`);
        console.log(`  anchored - blind: mean ${pp(_mean(deltas))}  median ${pp(_med(deltas))}  sd ${pp(_sd(deltas))}  share>0 ${pct(deltas.filter(d => d > 0).length / deltas.length)}`);
        if (vsMkt.length) {
            console.log(`  vs market (n=${vsMkt.length}): anchored - devig mean ${pp(_mean(vsMkt.map(v => v.anch)))};  blind - devig mean ${pp(_mean(vsMkt.map(v => v.blind)))}`);
        }
        console.log('  READ: positive mean = seeing the tip+price pulls the model TOWARD the bet (anchoring bias).');
    } else console.log(`  no comparable pairs yet (${pairable} pairs, ${offMenu} tips outside the blind menu).`);

    // ================= M2 — AI-MARKET DISSENT (no outcomes) =================
    console.log('\n############ M2 — blind-AI dissent from the devigged market ############');
    console.log('  market   n     mean      sd     share|d|>0.05  share|d|>0.10');
    const dissents = [];   // { fid, day, market, dissent, price, devig }
    for (const id of fids) {
        const e = byFixture.get(id);
        const probs = e.blind?.probabilities; const mp = price.get(id);
        if (!probs || !mp) continue;
        for (const m of BLIND_MARKETS) {
            const bp = probs[m]; if (bp == null) continue;
            const dv = devigProb(mp, m); if (dv == null) continue;
            dissents.push({ fid: id, day: e.day, market: m, dissent: bp - dv, price: mp[m], devig: dv });
        }
    }
    for (const m of BLIND_MARKETS) {
        const ds = dissents.filter(d => d.market === m).map(d => d.dissent);
        if (!ds.length) { console.log(`  ${m.padEnd(7)}  0`); continue; }
        console.log(`  ${m.padEnd(7)} ${String(ds.length).padStart(4)}  ${pp(_mean(ds)).padStart(8)} ${pp(_sd(ds)).padStart(8)}     ${pct(ds.filter(x => Math.abs(x) > 0.05).length / ds.length).padStart(6)}        ${pct(ds.filter(x => Math.abs(x) > 0.10).length / ds.length).padStart(6)}`);
    }
    const allD = dissents.map(d => d.dissent);
    if (allD.length) {
        console.log(`  ALL     ${String(allD.length).padStart(4)}  ${pp(_mean(allD)).padStart(8)} ${pp(_sd(allD)).padStart(8)}     ${pct(allD.filter(x => Math.abs(x) > 0.05).length / allD.length).padStart(6)}        ${pct(allD.filter(x => Math.abs(x) > 0.10).length / allD.length).padStart(6)}`);
        console.log('  READ: sd ~ 0 = the AI just re-derives the market (no orthogonal info to hope for).');
        console.log('        Real dissent is NECESSARY for an edge, not sufficient - M3 arbitrates who is right.');
    }

    // ================= M3 — DISSENT CALIBRATION (settled only) =================
    console.log('\n############ M3 — does blind-AI dissent predict outcomes beyond the market? ############');
    const settledSet = new Set(settledIds);
    const settledD = dissents.filter(d => settledSet.has(d.fid)).map(d => {
        const e = byFixture.get(d.fid);
        const res = settle(d.market, Number(e.fh), Number(e.fa));
        return res == null ? null : { ...d, hit: res };
    }).filter(Boolean);
    const days = [...new Set(settledD.map(r => r.day))];
    console.log(`  settled (fixture,market) rows: ${settledD.length} over ${days.length} day(s)`
        + (settledD.length < MIN_TEST ? `  [UNDERPOWERED - reference floor ${MIN_TEST}; directional only]` : ''));
    if (settledD.length) {
        const BINS = [[-9, -0.10], [-0.10, -0.03], [-0.03, 0.03], [0.03, 0.10], [0.10, 9]];
        console.log('  dissent bin        n    mean(realized - devig)   (climbing column = AI adds info; rolling stats scored FLAT here)');
        for (const [lo, hi] of BINS) {
            const s = settledD.filter(r => r.dissent >= lo && r.dissent < hi);
            if (!s.length) { console.log(`  [${String(lo).padStart(5)},${String(hi).padStart(5)})     0`); continue; }
            const resid = _mean(s.map(r => (r.hit ? 1 : 0) - r.devig));
            console.log(`  [${String(lo).padStart(5)},${String(hi).padStart(5)})  ${String(s.length).padStart(4)}   ${pp(resid)}`);
        }
        // the eventual EV question, reported but power-labelled
        const slice = settledD.filter(r => r.dissent >= 0.05 && r.price >= BETTABLE_FLOOR);
        if (slice.length) {
            const e2 = flatEv(slice.map(r => ({ ...r, hit: r.hit })));
            const ci = days.length >= 5 ? dayClusteredBootstrap(slice, flatEv, { draws: 2000, seed: 3 }) : null;
            console.log(`  bet-where-AI-dissents (>=0.05, price>=1.20): n=${slice.length}  hit ${pct(hitRate(slice))}  flatEV ${ev(e2)}`
                + (ci ? `  CI[${ev(ci.lo)},${ev(ci.hi)}]` : '  [no CI - < 5 settled days]'));
        }
    }

    mkdirSync('tmp/sure-win', { recursive: true });
    writeFileSync('tmp/edge-sentinel.json', JSON.stringify({
        at: new Date().toISOString(), enriched: fids.length, settled: settledIds.length,
        anchoring: { n: deltas.length, mean: _mean(deltas), median: _med(deltas), sd: _sd(deltas) },
        dissent: { n: allD.length, mean: _mean(allD), sd: _sd(allD) },
        settledRows: settledD.length,
    }, null, 0));
    console.log('\nWrote tmp/edge-sentinel.json');
} finally {
    await closeDb();
}
