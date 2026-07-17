# M3 Any-Market Predictions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generalize the tip engine to pick the single best-supported market per fixture across 1X2/DC/O-U **+ BTTS, DNB, team totals, Odd/Even**, with book-integrity guards, a `void` outcome, honest per-market EV labels, and hot picks generalized per O/U line — per the approved spec `docs/dev/specs/2026-07-15-m3-any-market-predictions-design.md`.

**Architecture:** A pure `TIP_FAMILIES` registry inside `src/db/tip-rules.js` replaces the hardcoded candidate arrays; settlement gains `tipOutcome()` (`'hit'|'miss'|'void'`) with `tipHit()` kept as a byte-compatible boolean wrapper; the hotpicks loader re-keys odds via M2's `canonicalMarket`. Reliability is enforced by warehouse anchors (backtest before ship) + a Safe-pool market-maturity floor.

**Tech Stack:** Plain Node ES modules, node:test (offline, no DB), knex forward-only migrations, zod config. 4-space indent, single quotes, semicolons. Suite baseline: **478 passing** — every task ends green.

## Global Constraints

- Pure rules modules stay offline-testable (zero project imports EXCEPT the sanctioned precedent: magic-rules imports perf-rules labelers; tip-rules MAY import from `src/markets.js` — both are zero-dependency pure modules).
- Byte-compatibility: existing settled rows, `tip_breakdown` JSON shape, and today's tips for canonical-only fixtures must be reproduced exactly (existing tests unchanged and passing).
- Freeze-at-kickoff / settle-exactly-once invariants untouched. Never rewrite settled or past-kickoff rows.
- Migrations forward-only; never edit an applied migration.
- Frontend market keys are opaque strings; new keys must never crash a web code path.
- Conventional Commits; commit after every task.
- Every env knob added must land in `src/config.js` (zod) AND `.env.example`.

## File Structure (what changes where)

| File | Responsibility in M3 |
|---|---|
| `src/db/migrations/20260715000001_tip_market_v2.js` | Create: widen `tip_market`, add `void` to `tip_outcome` |
| `src/db/tip-rules.js` | Modify: settlement API, aggregates, book integrity, registry `bestTip`, `buildTipBooks`, labels |
| `src/markets.js` | Modify: `canonicalMarket` exposes `period` + team-total side info |
| `src/db/goals-rules.js` | Modify: `scoreOverLine`, per-line aggregates, `apiPredictionSignal(pred, line)` |
| `src/hotpicks.js` | Modify: loader, eligibility wiring, multi-line hot evaluation, void settle |
| `src/db/perf-rules.js` | Modify: `marketGroup` superset, void-aware `_stats` |
| `src/db/magic-rules.js` | Modify: calibration ROI, maturity floor, anchors, `tipMarketLabel` |
| `src/config.js` + `.env.example` | Modify: `TIP_MIN_OVERROUND`, `TIP_MAX_OVERROUND`, `TIP_MAX_BOOK_DIVERGENCE`, `HOTPICK_LINES`, `SAFE_MIN_MARKET_SETTLED` |
| `src/magic.js` | Modify: ship `minMarketSettled` in the `safe` policy object |
| `src/ai.js` | Modify: tip-review prompt names the market in plain words; bump prompt version |
| `web/src/App.jsx`, `web/src/components/DataTable.jsx`, `web/src/components/TipPopover.jsx`, `web/src/filterValues.js` | Modify: safe settle, void pill, EV label line |
| `scripts/backtest-sure-tips.js`, `scripts/backtest-hotpicks.js` | Modify: new-family warehouse replay; O/U line sweep |
| `tests/tip-rules.test.js`, `tests/goals-rules.test.js`, `tests/perf-rules.test.js`, `tests/magic-rules.test.js`, `tests/tip-filter.test.js`, `tests/markets.test.js`, `tests/filter-values.test.js` | Extend |

---

### Task 1: Migration — wider `tip_market`, `void` outcome

**Files:**
- Create: `src/db/migrations/20260715000001_tip_market_v2.js`

**Interfaces:**
- Produces: `fixture_predictions.tip_market VARCHAR(32)`, `tip_outcome ENUM('hit','miss','void')`. Later tasks persist keys like `TT:H:O 1.5` and outcome `'void'`.

- [x] **Step 1: Write the migration**

```js
// Widen the tip vocabulary for M3 any-market tips (spec 2026-07-15):
// tip_market must fit side-specific team-total keys ('TT:H:O 1.5'), and
// DNB pushes settle as 'void' (stake returned - neither hit nor miss).
export async function up(knex) {
    await knex.raw('ALTER TABLE fixture_predictions MODIFY tip_market VARCHAR(32) NULL COMMENT \'canonical tip market key, e.g. "1X", "O 2.5", "TT:H:O 1.5"\'');
    await knex.raw("ALTER TABLE fixture_predictions MODIFY tip_outcome ENUM('hit','miss','void') NULL");
}

export async function down(knex) {
    await knex.raw("ALTER TABLE fixture_predictions MODIFY tip_outcome ENUM('hit','miss') NULL");
    await knex.raw('ALTER TABLE fixture_predictions MODIFY tip_market VARCHAR(8) NULL');
}
```

- [x] **Step 2: Run the migration**

Run: `npm run migrate`
Expected: `Batch 12 run: 1 migrations` (batch number may differ if the local DB drifted — what matters is this single file applying cleanly).

- [x] **Step 3: Verify columns**

Run: `node -e "import('./src/db/connection.js').then(async ({db}) => { const [r] = await db.raw('SHOW COLUMNS FROM fixture_predictions LIKE \'tip_%\''); console.log(r.map(c => c.Field + ' ' + c.Type).join('\n')); await db.destroy(); })"`
Expected: `tip_market varchar(32)` and `tip_outcome enum('hit','miss','void')`.

- [x] **Step 4: Run suite, commit**

Run: `npm test` → 478 pass. Then:
```bash
git add src/db/migrations/20260715000001_tip_market_v2.js
git commit -m "feat(db): widen tip_market to 32 chars + void tip outcome (M3)"
```

---

### Task 2: Settlement API — `tipOutcome` / `tipHitSafe` + new-family settles

**Files:**
- Modify: `src/db/tip-rules.js` (around the current `tipHit`, `:166-182`)
- Test: `tests/tip-rules.test.js`

**Interfaces:**
- Produces: `tipOutcome(market, ftHome, ftAway) → 'hit'|'miss'|'void'` (throws TypeError on unknown), `tipHit(market, fh, fa) → boolean` (unchanged contract: `tipOutcome(...) === 'hit'`, still throws), `tipHitSafe(market, fh, fa) → 'hit'|'miss'|'void'|null` (never throws — browser call sites).
- New settleable keys: `GG`, `NG`, `DNB1`, `DNB2`, `ODD`, `EVEN`, `TT:H:O <line>`, `TT:H:U <line>`, `TT:A:O <line>`, `TT:A:U <line>`.

- [x] **Step 1: Write failing tests** (append to `tests/tip-rules.test.js`)

```js
import { tipOutcome, tipHitSafe } from '../src/db/tip-rules.js';

test('tipOutcome settles the new families', () => {
    assert.equal(tipOutcome('GG', 2, 1), 'hit');
    assert.equal(tipOutcome('GG', 2, 0), 'miss');
    assert.equal(tipOutcome('NG', 0, 0), 'hit');
    assert.equal(tipOutcome('DNB1', 2, 1), 'hit');
    assert.equal(tipOutcome('DNB1', 1, 1), 'void');   // draw = push
    assert.equal(tipOutcome('DNB2', 1, 1), 'void');
    assert.equal(tipOutcome('DNB2', 0, 1), 'hit');
    assert.equal(tipOutcome('ODD', 2, 1), 'hit');
    assert.equal(tipOutcome('EVEN', 2, 1), 'miss');
    assert.equal(tipOutcome('TT:H:O 1.5', 2, 0), 'hit');
    assert.equal(tipOutcome('TT:H:O 1.5', 1, 3), 'miss');
    assert.equal(tipOutcome('TT:A:U 2.5', 1, 3), 'miss');
    assert.equal(tipOutcome('TT:A:U 2.5', 3, 1), 'hit');
});
test('tipOutcome matches legacy tipHit on canonical markets', () => {
    for (const [m, fh, fa] of [['1', 2, 1], ['X', 1, 1], ['X2', 0, 1], ['O 2.5', 2, 1], ['U 4.5', 2, 1]]) {
        assert.equal(tipOutcome(m, fh, fa) === 'hit', tipHit(m, fh, fa));
    }
});
test('unknown market: tipOutcome throws, tipHitSafe returns null', () => {
    assert.throws(() => tipOutcome('CS:2-1', 2, 1), TypeError);
    assert.equal(tipHitSafe('CS:2-1', 2, 1), null);
    assert.equal(tipHitSafe('DNB1', 1, 1), 'void');
});
```

- [x] **Step 2: Run to verify failure**

Run: `node --test tests/tip-rules.test.js`
Expected: FAIL — `tipOutcome` is not exported.

- [x] **Step 3: Implement** — replace the body of `tipHit` with delegation:

```js
const _TT_KEY = /^TT:(H|A):([OU]) (\d+\.5)$/;

// Settle any tippable market from the final score: 'hit' | 'miss' | 'void'.
// 'void' = stake returned (DNB push on a draw). Throws on unknown keys -
// a persisted unknown tip_market is a bug and must be loud (server); browser
// call sites use tipHitSafe below.
export function tipOutcome(market, ftHome, ftAway) {
    const total = ftHome + ftAway;
    const _b = v => (v ? 'hit' : 'miss');
    switch (market) {
        case '1': return _b(ftHome > ftAway);
        case 'X': return _b(ftHome === ftAway);
        case '2': return _b(ftHome < ftAway);
        case '1X': return _b(ftHome >= ftAway);
        case 'X2': return _b(ftHome <= ftAway);
        case '12': return _b(ftHome !== ftAway);
        case 'GG': return _b(ftHome > 0 && ftAway > 0);
        case 'NG': return _b(!(ftHome > 0 && ftAway > 0));
        case 'DNB1': return ftHome === ftAway ? 'void' : _b(ftHome > ftAway);
        case 'DNB2': return ftHome === ftAway ? 'void' : _b(ftHome < ftAway);
        case 'ODD': return _b(total % 2 === 1);
        case 'EVEN': return _b(total % 2 === 0);
        default: {
            const ou = /^([OU]) (\d+\.5)$/.exec(market);
            if (ou) return _b(ou[1] === 'O' ? total > Number(ou[2]) : total < Number(ou[2]));
            const tt = _TT_KEY.exec(market);
            if (!tt) throw new TypeError(`Unknown tip market: ${market}`);
            const goals = tt[1] === 'H' ? ftHome : ftAway;
            return _b(tt[2] === 'O' ? goals > Number(tt[3]) : goals < Number(tt[3]));
        }
    }
}

// Legacy boolean contract (canonical call sites): hit-or-not. A DNB void is
// NOT a hit. Still throws on unknown keys.
export function tipHit(market, ftHome, ftAway) {
    return tipOutcome(market, ftHome, ftAway) === 'hit';
}

// Never-throw variant for browser code paths (unknown/legacy keys -> null).
export function tipHitSafe(market, ftHome, ftAway) {
    try { return tipOutcome(market, ftHome, ftAway); } catch { return null; }
}
```

- [x] **Step 4: Run tests** — `node --test tests/tip-rules.test.js` PASS, then `npm test` all green.

- [x] **Step 5: Commit** — `git add -A && git commit -m "feat(tips): tipOutcome settlement API with void + new-family settles (M3)"`

---

### Task 3: Aggregates — BTTS / parity / per-side goals rates

**Files:**
- Modify: `src/db/tip-rules.js` (`teamOutcomeAggregates` `:63-82`, `h2hOutcomeAggregates` `:98-117`)
- Test: `tests/tip-rules.test.js`

**Interfaces:**
- Produces (added fields, existing fields untouched): `teamOutcomeAggregates(...)` gains `bttsRate`, `oddRate`, `scoredOverRates {line: rate}`, `concededOverRates {line: rate}` (team's own goals > line / goals conceded > line, over `OU_LINES`). `h2hOutcomeAggregates(...)` gains `bttsRate` and `oddRate` only (per-side H2H rates are YAGNI — Task 5's TT stats blend uses team aggregates alone). Empty-sample returns carry `null` for all new fields.

- [x] **Step 1: Write failing tests**

```js
const HIST = [
    // team 10 home: scored 3, conceded 1 (btts, odd total, over 2.5)
    { home_team_id: 10, away_team_id: 30, ft_home: 3, ft_away: 1, kickoff: '2026-07-01T12:00:00Z' },
    // team 10 away: scored 0, conceded 2 (no btts, even total)
    { home_team_id: 40, away_team_id: 10, ft_home: 2, ft_away: 0, kickoff: '2026-07-03T12:00:00Z' },
];
test('teamOutcomeAggregates: btts/parity/per-side goal rates', () => {
    const a = teamOutcomeAggregates(HIST, 10, 99, Date.parse('2026-07-10'), 5);
    assert.equal(a.n, 2);
    assert.equal(a.bttsRate, 0.5);                // 3-1 both scored; 2-0 not
    assert.equal(a.oddRate, 0);                   // totals 4 and 2 - both even
    assert.equal(a.scoredOverRates[0.5], 0.5);    // scored 3 (home) and 0 (away)
    assert.equal(a.scoredOverRates[2.5], 0.5);
    assert.equal(a.concededOverRates[1.5], 0.5);  // conceded 1 and 2
});
test('h2hOutcomeAggregates gains bttsRate/oddRate', () => {
    const h = h2hOutcomeAggregates([
        { home_team_id: 10, away_team_id: 20, ft_home: 2, ft_away: 1, kickoff: '2026-07-01T12:00:00Z' },
    ], 10, 20, Date.parse('2026-07-10'), 5);
    assert.equal(h.bttsRate, 1);
    assert.equal(h.oddRate, 1); // total 3
});
```

- [x] **Step 2: Run to verify failure** — `node --test tests/tip-rules.test.js` FAIL (`bttsRate` undefined).

- [x] **Step 3: Implement** — inside the existing `for (const f of recent)` loop of `teamOutcomeAggregates`, accumulate alongside `w`/`d`:

```js
    let btts = 0, odd = 0;
    const scoredOver = Object.fromEntries(OU_LINES.map(l => [l, 0]));
    const concededOver = Object.fromEntries(OU_LINES.map(l => [l, 0]));
    for (const f of recent) {
        const [gf, ga] = f.home_team_id === teamId ? [f.ft_home, f.ft_away] : [f.ft_away, f.ft_home];
        if (gf > ga) w++;
        else if (gf === ga) d++;
        if (f.ft_home > 0 && f.ft_away > 0) btts++;
        if ((f.ft_home + f.ft_away) % 2 === 1) odd++;
        for (const l of OU_LINES) {
            if (gf > l) scoredOver[l]++;
            if (ga > l) concededOver[l]++;
        }
    }
```
and extend the return with `bttsRate: _round(btts / n)`, `oddRate: _round(odd / n)`, `scoredOverRates: Object.fromEntries(OU_LINES.map(l => [l, _round(scoredOver[l] / n)]))`, `concededOverRates: (same for concededOver)`. Empty return (`:68`) gains the four fields as `null`. Mirror in `h2hOutcomeAggregates` (btts/odd identical; the per-side rates use the home perspective `[gf, ga]` already computed there → `homeScoredOverRates` from gf, `awayScoredOverRates` from ga). `pairedTeamOutcomeAggregates` needs no change (it re-calls the extended function).

- [x] **Step 4: Run tests** — targeted then `npm test`, all green (existing asserts untouched — additive fields only).

- [x] **Step 5: Commit** — `git commit -am "feat(tips): btts/parity/per-side goal aggregates (M3)"`

---

### Task 4: Book integrity — `bookIntegrity` + `selectFamilyBook`

**Files:**
- Modify: `src/db/tip-rules.js`; add knobs to `src/config.js` + `.env.example`
- Test: `tests/tip-rules.test.js`

**Interfaces:**
- Produces: `DEFAULT_TIP` gains `minOverround: 1.01`, `maxOverround: 1.30`, `maxBookDivergence: 0.15`.
- `bookIntegrity(prices: number[], opts) → { ok: boolean, overround: number|null, reason: string|null }` — reasons: `'incomplete'` (any price missing/≤1), `'overround_low'`, `'overround_high'`.
- `selectFamilyBook(providers, keys, opts) → { book: {key: price}|null, overround: number|null, reason: string|null }` — `providers` is `{ betpawa?: {key:price}, betika?: {key:price} }`; preference order betpawa→betika (today's `_group` rule at `hotpicks.js:60-68`); when BOTH providers carry the full group and their devigged probabilities diverge by more than `maxBookDivergence` on any outcome, returns `{ book: null, reason: 'book_divergence' }`.
- Config: `TIP_MIN_OVERROUND` / `TIP_MAX_OVERROUND` / `TIP_MAX_BOOK_DIVERGENCE` (zod `z.coerce.number()` with the defaults above, placed beside `TIP_MIN_PRICE` at `src/config.js:45`).

- [x] **Step 1: Write failing tests**

```js
import { bookIntegrity, selectFamilyBook } from '../src/db/tip-rules.js';

test('bookIntegrity: overround window + completeness', () => {
    assert.deepEqual(bookIntegrity([2.0, 3.6, 3.4]).ok, true);            // ~1.07 vig
    assert.equal(bookIntegrity([2.6, 4.2, 4.0]).reason, 'overround_low');  // sum < 1 = palp/boost
    assert.equal(bookIntegrity([1.5, 2.5, 2.5]).reason, 'overround_high'); // 1.47 margin-loaded
    assert.equal(bookIntegrity([2.0, null, 3.4]).reason, 'incomplete');
});
test('selectFamilyBook: prefers betpawa, rejects divergent books', () => {
    const keys = ['GG', 'NG'];
    const ok = selectFamilyBook({ betpawa: { GG: 1.9, NG: 1.9 }, betika: { GG: 1.95, NG: 1.85 } }, keys);
    assert.equal(ok.book.GG, 1.9);
    // betika says GG 80%, betpawa says 50% -> divergence veto
    const div = selectFamilyBook({ betpawa: { GG: 1.9, NG: 1.9 }, betika: { GG: 1.18, NG: 4.8 } }, keys);
    assert.equal(div.book, null);
    assert.equal(div.reason, 'book_divergence');
    // single provider, sane book -> accepted with measured overround
    const solo = selectFamilyBook({ betpawa: { GG: 1.9, NG: 1.9 } }, keys);
    assert.ok(solo.overround > 1.0 && solo.book);
});
```

- [x] **Step 2: Run to verify failure.**

- [x] **Step 3: Implement**

```js
// Bookmaker-trick guards (spec §4.2). A family book must be complete and its
// implied-probability sum inside a sane band: below 1.0 smells like a palpable
// error / boosted price masquerading as a hidden gem; far above it is margin
// loading so heavy the devigged number is meaningless.
export function bookIntegrity(prices, opts = {}) {
    const t = { ...DEFAULT_TIP, ...opts };
    const inv = prices.map(p => (Number(p) > 1 ? 1 / Number(p) : null));
    if (inv.some(v => v == null)) return { ok: false, overround: null, reason: 'incomplete' };
    const overround = _round(inv.reduce((a, b) => a + b, 0));
    if (overround < t.minOverround) return { ok: false, overround, reason: 'overround_low' };
    if (overround > t.maxOverround) return { ok: false, overround, reason: 'overround_high' };
    return { ok: true, overround, reason: null };
}

// Pick one provider's FULL family book (betpawa first, betika fallback -
// mixing providers inside one group breaks the vig removal), guarded by
// bookIntegrity and a cross-provider divergence veto: when both books are
// complete but disagree beyond maxBookDivergence on any outcome's devigged
// probability, one of them is likely a trap or error - no tip.
export function selectFamilyBook(providers, keys, opts = {}) {
    const t = { ...DEFAULT_TIP, ...opts };
    const books = [];
    for (const p of ['betpawa', 'betika']) {
        const m = providers?.[p];
        if (!m || !keys.every(k => Number(m[k]) > 1)) continue;
        const prices = keys.map(k => m[k]);
        const integ = bookIntegrity(prices, t);
        books.push({ provider: p, book: Object.fromEntries(keys.map(k => [k, Number(m[k])])), ...integ, probs: _devig(prices) });
    }
    const sane = books.filter(b => b.ok);
    if (!sane.length) return { book: null, overround: books[0]?.overround ?? null, reason: books[0]?.reason ?? 'incomplete' };
    if (sane.length === 2) {
        const gap = Math.max(...keys.map((k, i) => Math.abs(sane[0].probs[i] - sane[1].probs[i])));
        if (gap > t.maxBookDivergence) return { book: null, overround: sane[0].overround, reason: 'book_divergence' };
    }
    return { book: sane[0].book, overround: sane[0].overround, reason: null };
}
```
Add the three `DEFAULT_TIP` keys, the three zod config entries (mirroring the `TIP_MIN_PRICE` idiom at `src/config.js:45`), and the three `.env.example` lines (commented, with defaults).

- [x] **Step 4: Run tests, all green.** Note: existing `_devig` is reused — do not duplicate it.

- [x] **Step 5: Commit** — `git commit -am "feat(tips): book-integrity guards - overround window + divergence veto (M3)"`

---

### Task 5: `bestTip` registry — candidates across all seven families

**Files:**
- Modify: `src/db/tip-rules.js` (`bestTip` `:194-284`, `tipEligibility` `:148-164`)
- Test: `tests/tip-rules.test.js`

**Interfaces:**
- Consumes: Task 3 aggregates fields, Task 4 `selectFamilyBook` output shape.
- Produces: `bestTip(input, opts)` where `input` gains optional books `btts {GG,NG}`, `dnb {DNB1,DNB2}`, `oddEven {ODD,EVEN}`, `tt { H: {[line]: {over,under}}, A: {[line]: {over,under}} }` alongside the existing `x12/dc/ou/home/away/h2h/apiPercents`. Books arrive ALREADY integrity-screened (Task 6's loader runs `selectFamilyBook`); `bestTip` additionally accepts `overrounds` (`{family: number}`) and stamps the winning candidate's family overround as `book_overround` on the return + each runner-up. Return shape otherwise unchanged (`market, price, confidence, market_prob, stats_prob, api_prob, weights, samples, runners_up`).
- `tipEligibility` `no_markets` check extended: eligible when ANY of `x12/dc/ou/btts/dnb/oddEven/tt` is present/non-empty.
- New-family candidate rules: **BTTS** stats = `_mean([home.bttsRate, away.bttsRate, h2h.bttsRate])` (each behind its existing sample gate: `hOk`/`aOk`/`hhOk`), `NG` stats = `1 - bttsStats`; **DNB** market prob = devig of the 2-price book, stats = `statsProb['1'] / (statsProb['1'] + statsProb['2'])` for `DNB1` (renormalized win-vs-win, null when either side null), mirror for `DNB2`; **Odd/Even** stats = `_mean([home.oddRate, away.oddRate, h2h.oddRate])`, `EVEN = 1 - odd`; **team totals** (FT only): for `TT:H:O <line>` stats = `_mean([hOk ? home.scoredOverRates[line] : null, aOk ? away.concededOverRates[line] : null])`, Under = `1 - over-stats`; `minUnderLine` does NOT apply to TT Unders (it is a total-goals rule; TT lines are 0.5–3.5 by nature) but the global `minPrice` floor applies everywhere. API percents back result/DC only (unchanged).

- [x] **Step 1: Write failing tests** — three focused cases:

```js
test('bestTip considers BTTS and can pick GG', () => {
    const agg = { n: 6, winRate: 0.5, drawRate: 0.2, lossRate: 0.3, overRates: O(0.8), bttsRate: 0.9, oddRate: 0.5, scoredOverRates: O(0.8), concededOverRates: O(0.7) };
    const tip = bestTip({ btts: { GG: 1.55, NG: 2.3 }, home: agg, away: agg, h2h: { n: 0 }, apiPercents: null }, { minConfidence: 0.5 });
    assert.equal(tip.market, 'GG');
    assert.ok(tip.stats_prob > 0.8);
});
test('bestTip DNB stats renormalize over non-draw outcomes', () => {
    // statsProb['1'] blends home.winRate/away.lossRate/h2h -> with symmetric
    // aggregates below, statsProb 1 = .6, 2 = .2 -> DNB1 stats = .6/.8 = .75
    const home = { n: 6, winRate: 0.6, drawRate: 0.2, lossRate: 0.2, overRates: O(0.5), bttsRate: 0.5, oddRate: 0.5, scoredOverRates: O(0.5), concededOverRates: O(0.5) };
    const away = { n: 6, winRate: 0.2, drawRate: 0.2, lossRate: 0.6, overRates: O(0.5), bttsRate: 0.5, oddRate: 0.5, scoredOverRates: O(0.5), concededOverRates: O(0.5) };
    const tip = bestTip({ dnb: { DNB1: 1.5, DNB2: 2.6 }, home, away, h2h: { n: 0 }, apiPercents: null }, { minConfidence: 0 });
    const dnb1 = [tip, ...(tip.runners_up ?? [])].find(c => c.market === 'DNB1');
    assert.equal(dnb1.stats_prob, 0.75);
});
test('bestTip TT:H uses scored-vs-conceded blend', () => {
    const home = { n: 6, winRate: 0.5, drawRate: 0.2, lossRate: 0.3, overRates: O(0.5), bttsRate: 0.5, oddRate: 0.5, scoredOverRates: O(0.9), concededOverRates: O(0.3) };
    const away = { n: 6, winRate: 0.3, drawRate: 0.2, lossRate: 0.5, overRates: O(0.5), bttsRate: 0.5, oddRate: 0.5, scoredOverRates: O(0.3), concededOverRates: O(0.8) };
    const tip = bestTip({ tt: { H: { 1.5: { over: 1.7, under: 2.0 } } }, home, away, h2h: { n: 0 }, apiPercents: null }, { minConfidence: 0 });
    assert.equal(tip.market, 'TT:H:O 1.5');
    // stats = mean(home.scoredOverRates[1.5]=.9, away.concededOverRates[1.5]=.8)
    assert.equal(tip.stats_prob, 0.85);
});
test('legacy byte-compat: canonical-only input reproduces the pre-M3 tip exactly', () => {
    // Reuse an existing test's input verbatim; assert deepEqual on the FULL return object.
});
```
(Write the three sketched bodies out fully — helper `O(r)` builds `{0.5:r,...,6.5:r}` overRates.)

- [x] **Step 2: Run to verify failure.**

- [x] **Step 3: Implement.** Realization note (spec §4.1): the spec's `TIP_FAMILIES` registry is realized as per-family candidate blocks inside `bestTip` plus the `tipOutcome` settle switch — the three legacy families share devig context (DC derives from the 1X2 book; API percents span result+DC), which a literal object-table would have to thread awkwardly. Per-family logic still lives in exactly one place each and is independently tested; a future family is one new block + one settle case. Restructure the candidate enumeration (keep `consider()` verbatim, add an `overround` pass-through param stamped onto each candidate):

```js
    // -- existing x12/dc/ou blocks stay EXACTLY as today (byte-compat) --

    if (btts) {
        const probs = _devig([btts.GG, btts.NG]);
        if (probs) {
            const gg = _mean([hOk ? home.bttsRate : null, aOk ? away.bttsRate : null, hhOk ? h2h.bttsRate : null]);
            consider('GG', btts.GG, probs[0], gg, null);
            consider('NG', btts.NG, probs[1], gg == null ? null : 1 - gg, null);
        }
    }
    if (dnb) {
        const probs = _devig([dnb.DNB1, dnb.DNB2]);
        if (probs) {
            const w1 = statsProb['1'], w2 = statsProb['2'];
            const dnb1 = w1 != null && w2 != null && (w1 + w2) > 0 ? w1 / (w1 + w2) : null;
            consider('DNB1', dnb.DNB1, probs[0], dnb1, null);
            consider('DNB2', dnb.DNB2, probs[1], dnb1 == null ? null : 1 - dnb1, null);
        }
    }
    if (oddEven) {
        const probs = _devig([oddEven.ODD, oddEven.EVEN]);
        if (probs) {
            const odd = _mean([hOk ? home.oddRate : null, aOk ? away.oddRate : null, hhOk ? h2h.oddRate : null]);
            consider('ODD', oddEven.ODD, probs[0], odd, null);
            consider('EVEN', oddEven.EVEN, probs[1], odd == null ? null : 1 - odd, null);
        }
    }
    for (const side of ['H', 'A']) {
        for (const [line, pair] of Object.entries(tt?.[side] ?? {})) {
            const probs = _devig([pair.over, pair.under]);
            if (!probs) continue;
            const scoredSide = side === 'H' ? home : away, otherSide = side === 'H' ? away : home;
            const over = _mean([
                (side === 'H' ? hOk : aOk) ? scoredSide.scoredOverRates?.[line] : null,
                (side === 'H' ? aOk : hOk) ? otherSide.concededOverRates?.[line] : null,
            ]);
            consider(`TT:${side}:O ${line}`, pair.over, probs[0], over, null);
            consider(`TT:${side}:U ${line}`, pair.under, probs[1], over == null ? null : 1 - over, null);
        }
    }
```
Stamp overrounds: `consider` gains a final optional `overround` arg pushed as `overround` on the candidate; each family block passes `overrounds?.<family>`. The winner's copy also surfaces as `book_overround` in the final return (margin transparency, spec §4.2). Extend `tipEligibility`'s `no_markets` line:

```js
    const anyBook = x12 || dc || Object.keys(ou ?? {}).length
        || btts || dnb || oddEven || Object.keys(tt?.H ?? {}).length || Object.keys(tt?.A ?? {}).length;
    if (!anyBook) return { eligible: false, reason: 'no_markets' };
```
(destructure the new names in both function signatures).

- [x] **Step 4: Run tests** — targeted + `npm test`. The byte-compat deepEqual is the gate: if it fails, the canonical path changed — fix before proceeding.

- [x] **Step 5: Commit** — `git commit -am "feat(tips): bestTip candidates across btts/dnb/team-total/odd-even (M3)"`

---

### Task 6: Loader — `buildTipBooks` + `canonicalMarket` side/period exposure + hotpicks wiring

**Files:**
- Modify: `src/markets.js` (`canonicalMarket` `:226-279`), `src/db/tip-rules.js` (new `buildTipBooks`), `src/hotpicks.js` (`_loadMarkets` `:43-83`, fixture loop `:194-244`, settle loop `:103-120`)
- Test: `tests/markets.test.js`, `tests/tip-rules.test.js`

**Interfaces:**
- `canonicalMarket(row)` return gains two ADDITIVE fields: `period` (`null|'1H'|'2H'|'<N>m'` — already computed internally as `period`) and, for `team_total` rows only, `tt: { team: string|null, side: 'home'|'away'|null }` (from the internal `_teamTotalMatch`). No existing field changes.
- `buildTipBooks(oddsRows, { homeName, awayName }, opts) → { x12, dc, ou, btts, dnb, oddEven, tt, overrounds, rejects }` in tip-rules (imports `canonicalMarket` from `../markets.js` — sanctioned cross-pure import, magic-rules precedent). `oddsRows` = one fixture's raw `{provider, type_name, name, handicap, price}` rows. Rules: skip any row whose descriptor has `period != null` (FT only), skip stale-excluded rows upstream (loader passes only `is_stale=0` rows, as today); group per provider per family key; run `selectFamilyBook` per family/line; TT side from `tt.side` directly or normalized team-name match (`tt.team` uppercased-trimmed equality against home/away name uppercased-trimmed; no fuzzy matching — unresolved = excluded); `overrounds` = `{family: overround}` for accepted books; `rejects` = `{family: reason}` for refused ones (audit).
- `_loadMarkets(fixtureIds, namesById)` now returns `Map(fixture_id → buildTipBooks(...) result)`; `updateHotPicks` passes `new Map(targets.map(f => [f.id, { homeName: f.home_name, awayName: f.away_name }]))`.
- `settleHotPicks` tip loop switches `tipHit` → `tipOutcome` with three buckets (`hit`/`miss`/`void`).

- [x] **Step 1: Failing tests.** In `tests/markets.test.js`: `canonicalMarket` on a Betika `'ARSENAL TOTAL'` O/U row returns `tt.team === 'ARSENAL'` and `period === null`; on a BetPawa 1st-half BTTS spelling returns `period === '1H'`. In `tests/tip-rules.test.js`: `buildTipBooks` with (a) a full betpawa 1X2 + a Betika-only GG/NG book → both families present; (b) a `'FOO TOTAL'` row that matches neither team name → `tt` empty + no crash; (c) a period-tagged O/U row → excluded from `ou`; (d) a palp-priced BTTS book → `rejects.btts === 'overround_low'`.

- [x] **Step 2: Run to verify failure.**

- [x] **Step 3: Implement.** `markets.js`: in the team-total branch return `{ key, group, label, columnizable, period: period || null, tt: { team: tt.team || null, side: tt.side || null } }`; in the other two return sites add `period: period || null` (fixed families) / `period: null` (combo, raw). `tip-rules.buildTipBooks`: walk rows → `canonicalMarket`; keep keys in `{'1','X','2','1X','X2','12','GG','NG','DNB1','DNB2','ODD','EVEN'}` or O/U (`/^[OU] \d+\.5$/`) or team-total (side-resolved, line via the O/U key inside `TT:<ouKey>`); bucket per provider (lowest price per key, as `hotpicks.js:56-58`); assemble family groups via `selectFamilyBook` per family (O/U and TT per line — each line is its own two-way book). `hotpicks.js`: `_loadMarkets` slims to the SQL + per-fixture row grouping and delegates to `buildTipBooks`; the fixture loop destructures the new groups and passes them to `tipEligibility`/`bestTip` (both spread `...groups` already — verify the spread still carries `x12/dc/ou` for `scoreOver25`'s `groups.ou[2.5]` use at `:195`); pass `overrounds` through. `settleHotPicks`:

```js
    const buckets = { hit: [], miss: [], void: [] };
    for (const t of pendingTips) {
        if (t.fh == null || t.fa == null) continue;
        buckets[tipOutcome(t.tip_market, t.fh, t.fa)].push(t.fixture_id);
    }
    for (const [outcome, ids] of Object.entries(buckets)) { /* same chunked update */ }
```

- [x] **Step 4: Run `npm test`** — green. Also run a REAL smoke: `node src/index.js hotpicks` against the local DB; expect a normal summary line, zero throws, and (likely) some new-family tips on rich BetPawa dates.

- [x] **Step 5: Commit** — `git commit -am "feat(tips): canonical-market tip books w/ TT side resolution + void settle (M3)"`

---

### Task 7: Hot picks per O/U line — `scoreOverLine`

**Files:**
- Modify: `src/db/goals-rules.js`, `src/hotpicks.js` (fixture loop + settle SQL `:91-98`), `src/config.js`, `.env.example`
- Test: `tests/goals-rules.test.js`

**Interfaces:**
- `teamGoalsAggregates`/`h2hGoalsAggregates` gain `overRates {line: rate}` over `[0.5,1.5,2.5,3.5,4.5,5.5,6.5]` (existing `overRate` stays = the 2.5 value; byte-compat).
- `apiPredictionSignal(pred, line = 2.5)` — over-advice at ≥ line supports; under-advice at ≤ line contradicts (current behavior is the `line = 2.5` case).
- `scoreOverLine(inputs, line, opts) → { hot, score, signals, api_supports }` with the same signal keys as today, values read from `overRates[line]` and the line's own devigged pair; `scoreOver25(inputs, opts)` becomes `scoreOverLine(inputs, 2.5, opts)` — existing tests must pass unchanged.
- `LINE_THRESHOLDS` export: `{ 2.5: DEFAULT_THRESHOLDS }` initially — other lines are added ONLY by Task 10's backtest (a line with no entry can never fire hot).
- Config: `HOTPICK_LINES` (CSV, default `'2.5'`) parsed via the existing `parseFilterList` idiom or a simple split — the hotpicks loop evaluates each configured line that has both a full O/U pair and a `LINE_THRESHOLDS` entry; the row keeps the 2.5 evaluation as its ledger baseline unless a different line fires hot with a higher score, in which case `market`,`over_price`,`under_price`,`implied_over`,`hot`,`score`,`signals` come from that line.
- Settle SQL becomes line-aware: `p.outcome = IF(total > CAST(SUBSTRING(p.market, 3) AS DECIMAL(4,2)), 'hit', 'miss')` (`'O 2.5'` → `SUBSTRING(...,3)='2.5'`; `total > 2.5` ≡ today's `>= 3`).

- [x] **Step 1: Failing tests** — `scoreOverLine(inputs, 1.5, {...})` gates on `overRates[1.5]`; `scoreOver25` output `deepEqual` to a pre-refactor captured result for a fixed input; `apiPredictionSignal({under_over:'+1.5'}, 1.5) === 'support'` while `apiPredictionSignal({under_over:'+1.5'}, 2.5) === null`.
- [x] **Step 2: Verify failure.**
- [x] **Step 3: Implement.** Core shape (signal keys byte-identical to today's `scoreOver25` — only the rate lookups move to the line):

```js
export const LINE_THRESHOLDS = { 2.5: DEFAULT_THRESHOLDS }; // other lines: Task 10 backtest only

export function scoreOverLine({ home, away, h2h, market, api }, line, opts = {}) {
    const t = { requireMarket: true, ...(LINE_THRESHOLDS[line] ?? DEFAULT_THRESHOLDS), ...opts };
    const hOver = home.overRates?.[line] ?? (line === 2.5 ? home.overRate : null);
    const aOver = away.overRates?.[line] ?? (line === 2.5 ? away.overRate : null);
    const hhOver = h2h.overRates?.[line] ?? (line === 2.5 ? h2h.overRate : null);
    // ... signals array exactly as scoreOver25 today (goals-rules.js:147-165),
    // with home.overRate -> hOver, away.overRate -> aOver, h2h.overRate -> hhOver
    // and avgTotal gates unchanged (they are line-agnostic form measures).
}

export function scoreOver25(inputs, opts = {}) {
    return scoreOverLine(inputs, 2.5, opts);
}
```
`teamGoalsAggregates`/`h2hGoalsAggregates` gain `overRates` via the same per-line loop as Task 3 (`f.ft_home + f.ft_away > l`); the legacy `overRate` field stays (`>= 3` ≡ `> 2.5`). `apiPredictionSignal(pred, line = 2.5)`: replace the literal `2.5`s at `goals-rules.js:127-128` with `line`. Hotpicks loop: for each `config.HOTPICK_LINES` line with a full pair AND a `LINE_THRESHOLDS` entry, run `scoreOverLine`; baseline row stays the 2.5 evaluation; a non-2.5 line replaces the hot columns only when it fires hot with a higher score.
- [x] **Step 4: `npm test` green + rerun `node src/index.js hotpicks` smoke.**
- [x] **Step 5: Commit** — `git commit -am "feat(hotpicks): line-parameterized scoreOverLine + line-aware settle (M3)"`

---

### Task 8: Measurement — perf-rules void/groups, calibration ROI, maturity floor, labels

**Files:**
- Modify: `src/db/perf-rules.js` (`marketGroup` `:22-27`, `_stats` `:47-68`), `src/db/magic-rules.js` (`computeCalibration` `:72-94`, `WAREHOUSE_WLO` comment `:148-164`, `DEFAULT_SAFE` `:330`, `safeQualifies` `:378`, `safeSelection` `:406`), `src/magic.js`, `src/config.js`, `.env.example`
- Test: `tests/perf-rules.test.js`, `tests/magic-rules.test.js`

**Interfaces:**
- `marketGroup` superset: `GG/NG → 'btts'`, `DNB1/DNB2 → 'dnb'`, `/^TT:/ → 'team_total'`, `ODD/EVEN → 'odd_even'`; existing branches byte-identical; unknown → `'other'`.
- `_stats` void-aware: `outcome === 'void'` → `s.voids++` (new field, always present, default 0), excluded from `settled`, no profit/stake effect.
- `computeCalibration`: void rows skipped for rate buckets (current `hit/miss` filter already does this — assert it); `cal.markets[key]` gains `staked`, `profit` (`+= price-1` on hit, `-1` on miss, only when price present) so the web can render ROI; `_tally` untouched — do the profit accumulation beside the `cal.markets` tally with the tip's price.
- `safeQualifies(row, opts, cal)` — NEW optional third param: when `cal` is provided and `opts.minMarketSettled > 0`, require `(cal.markets?.[tip.market]?.n ?? 0) >= opts.minMarketSettled`. `DEFAULT_SAFE.minMarketSettled = 30`. `safeSelection` passes its `cal` through. (Callers without `cal` — the web risk-gate badge — behave as before; the POOL is what the floor protects.)
- `tipMarketLabel(market) → string` export in magic-rules (shared verbatim web/server): `'1'→'Home win'`, `'X'→'Draw'`, `'2'→'Away win'`, `'1X'→'Home or draw'`, `'X2'→'Draw or away'`, `'12'→'Home or away'`, `O/U → 'Over 2.5 goals'/'Under 4.5 goals'`, `'GG'→'Both teams to score: Yes'`, `'NG'→'Both teams to score: No'`, `'DNB1'→'Home (draw no bet)'`, `'DNB2'→'Away (draw no bet)'`, `'ODD'/'EVEN'→'Odd/Even total goals'`, `TT:H:O 1.5 → 'Home team over 1.5 goals'` (mirror A/U), fallback = the raw key.
- `src/magic.js`: the `safe` policy object gains `minMarketSettled` from new env `SAFE_MIN_MARKET_SETTLED` (default 30, zod beside the other `SAFE_*`).
- `WAREHOUSE_WLO`: update the "deliberately no BTTS/TT anchors" comment to reference Task 10 (anchors now REQUIRED before those markets tip — spec §5) — values land in Task 10.

- [x] **Step 1: Failing tests** — `marketGroup('GG')==='btts'`, `marketGroup('TT:A:U 2.5')==='team_total'`; `_stats` sees `{outcome:'void', price:1.8}` → `voids:1, settled unchanged, profit 0`; `computeCalibration` markets bucket carries `profit/staked`; `safeQualifies(qualifyingRow, DEFAULT_SAFE, calWithThinMarket)` → false while the same row with a 40-settle market → true; `tipMarketLabel('TT:H:O 1.5') === 'Home team over 1.5 goals'`.
- [x] **Step 2: Verify failure.**
- [x] **Step 3: Implement.** Key diffs:

```js
// perf-rules.js - marketGroup superset (existing branches byte-identical)
export function marketGroup(market) {
    if (['1', 'X', '2'].includes(market)) return '1X2';
    if (['1X', 'X2', '12'].includes(market)) return 'double_chance';
    if (/^[OU] /.test(String(market))) return 'over_under';
    if (['GG', 'NG'].includes(market)) return 'btts';
    if (['DNB1', 'DNB2'].includes(market)) return 'dnb';
    if (/^TT:/.test(String(market))) return 'team_total';
    if (['ODD', 'EVEN'].includes(market)) return 'odd_even';
    return 'other';
}
// perf-rules.js _stats: before the hit/miss branches -
//   if (b.outcome === 'void') { s.voids++; continue; }   (init s.voids = 0)

// magic-rules.js computeCalibration: beside the cal.markets _tally -
//   const mb = cal.markets[String(t.market)];
//   if (t.price != null) { mb.staked = (mb.staked ?? 0) + 1;
//       mb.profit = _round((mb.profit ?? 0) + (hit ? Number(t.price) - 1 : -1)); }

// magic-rules.js safeQualifies gains the maturity floor (spec §5):
export function safeQualifies(row, opts = DEFAULT_SAFE, cal = null) {
    const o = { ...DEFAULT_SAFE, ...opts };
    const tip = tipView(row);
    if (!tip || tip.vetoed) return false;
    if ((o.minMarketSettled ?? 0) > 0 && cal
        && (cal.markets?.[String(tip.market)]?.n ?? 0) < o.minMarketSettled) return false;
    // ... existing gates unchanged (parts/agreement/price/sufficient-stats)
}
// safeSelection: safeQualifies(r, o) -> safeQualifies(r, o, cal)
```
`tipMarketLabel` per the Interfaces mapping (a small switch + two regexes; fallback = the raw key).
- [x] **Step 5: Commit** — `git commit -am "feat(measure): void-aware ledger, market ROI calibration, safe maturity floor, tip labels (M3)"`

---

### Task 9: Web + AI surfacing

**Files:**
- Modify: `web/src/App.jsx` (`:178-183`), `web/src/components/DataTable.jsx` (tip outcome pill), `web/src/components/TipPopover.jsx`, `web/src/filterValues.js` (`applyOutcomeToggles`), `src/ai.js` (tip prompt)
- Test: `tests/tip-filter.test.js`, `tests/filter-values.test.js` (offline; browser check in Task 11)

**Interfaces:**
- Consumes: `tipHitSafe`/`tipOutcome` (Task 2), `tipMarketLabel` + `cal.markets[key]` `{n,hits,profit,staked}` (Task 8).

- [x] **Step 1: Failing tests** — `tests/tip-filter.test.js`: `parseTipFilter('TT:H:O 1.5')` returns `{index:1, outcome:null, value:'TT:H:O 1.5'}`?? **No** — hand-trace `TIP_PREFIX` first: `[HM]?` CAN match the leading `T`? It cannot (`T`∉`[HM]`), so the regex fails at the anchor and the value parses plain — write the test asserting exactly that (plus `HTFT:1-x` and a CSV `in` list containing `TT:H:O 1.5`) so the collision stays impossible by test. `tests/filter-values.test.js`: `applyOutcomeToggles` with a `tip_outcome:'void'` row — Hide hits and Hide miss both keep it; No-miss does not blacklist its market.
- [x] **Step 2: Verify** (these may PASS immediately — that is the point: they pin the behavior; if one fails, fix the regex/toggle accordingly).
- [x] **Step 3: Implement the real changes:**
  - `App.jsx:182`: `const out = tipHitSafe(market, hs, as); if (out === 'hit') bucket.hits += 1; if (out !== 'hit' && out !== 'miss') { bucket.settled -= 1; }` — restructure so a runner-up only enters `settled` when out is hit/miss (import `tipHitSafe` instead of `tipHit`). Chosen-tip counting at `:172` already excludes voids (checks hit/miss literally) — leave it.
  - `DataTable.jsx`: tip outcome `'void'` renders a neutral grey pill/`↩` marker (reuse the muted token, e.g. `text-(--label-tertiary)`), tooltip "Void - stake returned (draw no bet push)".
  - `TipPopover.jsx`: replace the local `MARKET_LABEL` usage with `tipMarketLabel` (import from magic-rules like the other shared imports) and add the always-visible honesty line ABOVE the gated internals: from the magic payload's `cal.markets[tip_market]` — `n>=10`: "Tips on this market have hit {rate}% of {n} settled picks{roi != null ? ' (ROI {roi}%)' : ''}"; `0<n<10`: "New market - only {n} settled tips so far"; `n===0`: "New market - no settled tips yet". Thread `cal` from where the popover is rendered (DataTable receives the magic payload for ✨ scoring — verify the prop path at implementation time and pass `cal` down; if DataTable lacks it, lift from `App.jsx`'s magic-sort fetch state).
  - `src/ai.js`: the tip-review prompt includes `tipMarketLabel(tip.market)` beside the raw key, and the prompt-version suffix in `aiModelTag()` bumps (`#p2` → `#p3` or current+1) so cached verdicts re-adjudicate under the new prompt.
- [x] **Step 4: `npm test` green; `npm run build:web` clean.**
- [x] **Step 5: Commit** — `git commit -am "feat(web): void pill, per-market honesty label, safe tip settle; ai prompt labels (M3)"`

---

### Task 10: Backtests — warehouse anchors + hot-line thresholds (DB-bound)

**Files:**
- Modify: `scripts/backtest-sure-tips.js`, `scripts/backtest-hotpicks.js`, `src/db/magic-rules.js` (`WAREHOUSE_WLO`), `src/db/goals-rules.js` (`LINE_THRESHOLDS`), `.env.example` (`HOTPICK_LINES` guidance)

**Interfaces:**
- Consumes: `tipOutcome` (settles every new family offline from warehouse FT scores), `scoreOverLine`.
- Produces: `WAREHOUSE_WLO` entries for `GG,NG,DNB1,DNB2,ODD,EVEN` and the TT keys actually offered by the books; `LINE_THRESHOLDS` entries ONLY for lines whose tuned gates clear the precision bar.

- [x] **Step 1:** Extend `backtest-sure-tips.js`: for each settled warehouse fixture, enumerate the new-family stats probabilities (same aggregates the engine uses) and settle via `tipOutcome`; report temporal-OOS hit-rate per market key (same split idiom the script already uses). Voids excluded from denominators.
- [x] **Step 2:** Run `node scripts/backtest-sure-tips.js`; paste the OOS rates into `WAREHOUSE_WLO` with a dated comment (e.g. `// M3 2026-07-15 warehouse OOS`). Sanity: BTTS/TT anchors are EXPECTED to look strong stats-only — the comment at `magic-rules.js:148-158` explains why the live term must dominate; keep that framing.
- [x] **Step 3:** Extend `backtest-hotpicks.js` with `--line <L>` (default sweep `1.5,2.5,3.5`): replay each line's gates over the warehouse, print precision/recall per threshold grid. Add a `LINE_THRESHOLDS` entry ONLY for lines beating the current 2.5 bar (~73% stats-only precision) — if none do, ship `HOTPICK_LINES=2.5` unchanged and record the numbers in the plan-tick commit message (an honest "no expansion" is a valid outcome).
- [x] **Step 4:** `npm test` green (anchors change no logic; `safePrior` tests that pin specific anchor VALUES, if any, get updated literals).
- [x] **Step 5: Commit** — `git commit -am "feat(backtest): new-family warehouse anchors + hot-line sweep (M3)"`

---

### Task 11: E2E verification, docs, plan tick

**Files:**
- Modify: `CLAUDE.md` (architecture bullets for tip-rules/goals-rules/magic-rules/hotpicks + the `npm test` blurb), `docs/dev/implementation-plan.md` (M3 entry), `docs/dev/plans/2026-07-15-m3-any-market-tips.md` (checkboxes), `.env.example` (final knob audit)

- [x] **Step 1: Full suite + build** — `npm test` (target: 478 + ~35 new, all green), `npm run build:web`.
- [x] **Step 2: Live smoke on the local DB** — stop any running `serve` (single-writer rule), then `node src/index.js hotpicks`; verify: new-family tips appear on a rich BetPawa date (`SELECT tip_market, COUNT(*) FROM fixture_predictions WHERE tip_market NOT REGEXP '^(1|X|2|1X|X2|12|[OU] )' GROUP BY 1`), no key exceeds 32 chars, settle pass clean. Then `npm run serve` + browser (dev :5173 or built dist): tip cells render new markets with labels, popover shows the honesty line (signed-out AND signed-in), void styling visible on a DNB draw (seed one via a test row if none exists yet — and delete it after), Safe-only pool contains NO new-family tips (maturity floor), zero console errors, dark + mobile spot-check. Kill orphans, re-probe :3001 (memory: `taskkill //T`).
- [x] **Step 3: Docs** — CLAUDE.md: tip-rules bullet gains the registry/void/book-integrity/maturity-floor summary; goals-rules bullet gains `scoreOverLine`/`LINE_THRESHOLDS`; magic-rules bullet gains `tipMarketLabel`/market-ROI cal/`SAFE_MIN_MARKET_SETTLED`; commands blurb notes the new env knobs. `docs/dev/implementation-plan.md`: one M3 progress line.
- [x] **Step 4: Tick every checkbox here, commit** — `git commit -am "docs: M3 shipped - architecture notes + plan tick"`. Merge to `main` stays USER-GATED (ask, as always).

---

## Execution notes for workers

- Run `npm test` after EVERY task — the suite is the byte-compat guarantee.
- The local DB is a dev copy; Tasks 1/6/10/11 touch it. NEVER run against prod (deploys are manual cPanel; prod DB is unreachable from here anyway).
- Only ONE serve/pipeline process at a time (InnoDB gap-lock deadlocks — memory #22).
- If `hotpicks` smoke shows zero new-family tips, check `rejects` reasons before suspecting the registry — Betika carries no DNB/Odd-Even and BTTS books can legitimately fail the overround window.
