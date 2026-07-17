# M4.1 AI Enrichment Layer Implementation Plan

> **STATUS: COMPLETE 2026-07-16.** All 8 tasks committed on `feat/m4-ai-enrichment`
> (`1fcd952`..`9e8f210`). Suite 564/564, `build:web` clean.
>
> **Task 8 live-verification evidence (the sweep that closed the milestone):**
> - Both providers land: `openrouter` (blind, `openai/gpt-5.6-terra#e2`) and
>   `gemini` (anchored, `gemini-2.5-flash+search#e2`); `sources` populated on the
>   grounded rows.
> - **Leakage guard holds: 0** rows on a past-kickoff fixture; every enriched
>   fixture was `NS` with kickoff hours ahead.
> - **Reuse does not re-bill:** an identical repeat sweep wrote `0 insights, 0 errors`.
>
> **Deviation from Step 5 as written (deliberate, not an oversight):** the plan
> said to bump `PROMPT_VERSION` 1->2, confirm re-enrichment, then revert to 1.
> `PROMPT_VERSION` is legitimately **2** already (`9e8f210` bumped it when real
> stats replaced the placeholder), and that bump ALREADY proved tag invalidation
> live: fixture 1527336's rows carry `created_at 04:10` (written as `#e1`) with
> `updated_at 05:09` and tag `#e2` - the onConflict merge re-fired the calls and
> rewrote the row. Bumping to `#e3` would re-bill real AI calls to re-learn what
> those timestamps already evidence. Reverting to 1 would be wrong outright.
>
> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn AI from a boolean adjudicator into a measurable, multi-signal evidence source, and begin forward collection of features the warehouse cannot see.

**Architecture:** Three AI calls per upcoming fixture. A grounded Gemini call extracts typed facts ONCE; a blind non-Google reasoner and an anchored Gemini call then work that identical evidence, so `anchored − blind` on the same fixture+model is a *paired* measurement of the anchoring effect. Results land in a new `fixture_ai_insights` table (JSON payload + `schema_ver`). Collection only — nothing feeds ranking (that is M4.3, gated on replay).

**Tech Stack:** Node ESM, axios, zod, knex/MySQL, node:test. Providers: Google Gemini (`generateContent`, `google_search` grounding) and OpenRouter (OpenAI-compatible `chat/completions`).

**Source spec:** `docs/dev/specs/2026-07-16-m4-ai-enrichment-design.md` (APPROVED).

## Global Constraints

- **An AI call must never touch a past-kickoff fixture.** Selection is `kickoff > NOW()`, the same freeze idiom as `fixture_prematch` / tips / hot picks. A grounded call on a played match retrieves the final score — leakage that *looks like* brilliance. This gets an explicit test assertion, not just a convention.
- **Nothing in this milestone may feed `bestTip`, confidence, `magicSortRows`, `safeQualifies`, or any ranking.** This milestone fills a tank. Task 1 is the only behaviour change and it *removes* an unjustified signal.
- **Fail-open is preserved.** An AI error never breaks the pipeline (today's contract in `src/ai.js`).
- **ES modules, `async/await`, 4-space indentation, single quotes, semicolons.** No linter exists.
- **All external data through zod.** Keep field schemas tolerant (`nullable().optional()`) — live data has taught this repeatedly.
- **Pure `*-rules.js` modules import zod/node:crypto only** — no config/.env/DB — so tests run offline.
- **Migrations are forward-only.** Never edit an applied migration. **Batch 13 is already taken** by `20260716000001_odds_markets_catalog_index`; this plan uses **batch 14**.
- **`fixtures.id` is `int(10) unsigned`** — verified. The FK column must be `t.integer(...).unsigned()`, matching `fixture_predictions.fixture_id`. A BIGINT here fails with errno 150.
- **Secrets live in `.env` only, never in the settings catalog** (catalog excludes secrets by construction). API keys → `.env`; model + behaviour → catalog.
- **`OPENROUTER_MODEL` default is `openai/gpt-5.6-terra`** — verified present in OpenRouter's live `/api/v1/models` on 2026-07-16 (342 models). Non-Google is a *correctness requirement*: two Google models agreeing is Gemini agreeing with itself. `openrouter/auto` and `openrouter/free` both exist but are **disqualified** — they are auto-routers that silently vary the model per fixture, so the measurement would not know which brain it measured.
- **Honest labels.** No market is +EV; overall flat-stake EV is −4.3%. This layer buys evidence, not profit.

---

### Task 1: Stop acting on the AI veto

**Why this is first and urgent.** Spec §3.8 says the veto is "recorded, no longer acted on" because it does not discriminate. Measured on the live warehouse 2026-07-16:

| Verdict | n | Hit rate |
|---|---:|---:|
| `confirm` | 28 | 75.0% |
| `veto` | 33 | 72.7% |

Opening the AI faucet (`TIP_AI_MIN_CONFIDENCE 0.80→0`) turned this latent flaw live: of **170 upcoming tips, 125 (73.5%) are now vetoed**, 43 confirmed, 2 error. The veto currently reaches further than the spec's §3.8 wording implies — it is not only the strike-through:

- `magic-rules.js:356` `scoreTip` returns `null` when `tip.vetoed` → **125/170 rows sink to the bottom of every magic sort**, including the default `sure` view.
- `BetslipPlayground.jsx:122` filters `tip_ai_verdict !== 'veto'` → **125/170 tips vanish from the playground pool**.
- `DataTable.jsx:281-287` renders them struck through + dimmed.
- `magic-rules.js:448` `safeQualifies` returns `false` when vetoed. **Measured: the Safe pool is 0 both with and without the veto gate** (other gates bind first), so this one is currently inert — remove it for consistency, but do not claim it fixed anything.
- `magic-rules.js:655,663` exclude vetoed tips from slip simulation.

`hot = false` on veto (hot picks) is **unchanged** — different gate, different evidence base, explicitly out of scope (spec §3.8).

`tip_ai_verdict` keeps persisting, so the ledger can still prove what following the vetoes would have cost. This is reversible the moment the veto earns its place on data.

**Files:**
- Modify: `src/db/magic-rules.js:48` (`vetoed` field), `:356`, `:448`, `:655`, `:663`
- Modify: `web/src/components/DataTable.jsx:278-287`, `:326-332`
- Modify: `web/src/components/BetslipPlayground.jsx:111`, `:122`
- Test: `tests/magic-rules.test.js`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `_tipFields(r)` keeps emitting `vetoed: r.tip_ai_verdict === 'veto'` (still read by the popover + CSV export); no scorer or gate branches on it.

- [x] **Step 1: Write the failing tests**

Add to `tests/magic-rules.test.js`:

```javascript
test('a vetoed tip scores and ranks exactly like a confirmed one (veto is not acted on)', () => {
    const base = {
        api_id: 1, tip_market: '1X', tip_price: 1.4, tip_confidence: 0.8,
        tip_breakdown: { market_prob: 0.75, stats_prob: 0.7, api_prob: 0.7,
            samples: { home_n: 8, away_n: 8, h2h_n: 3 } },
    };
    const cal = computeCalibration([]);
    const confirmed = { ...base, tip_ai_verdict: 'confirm' };
    const vetoed = { ...base, tip_ai_verdict: 'veto' };
    for (const s of STRATEGIES) {
        assert.equal(scoreTip(vetoed, cal, s.id), scoreTip(confirmed, cal, s.id),
            `strategy ${s.id} must ignore the AI veto`);
    }
});

test('safeQualifies ignores the AI veto', () => {
    const row = {
        api_id: 1, tip_market: '1X', tip_price: 1.4, tip_confidence: 0.8,
        tip_ai_verdict: 'veto',
        tip_breakdown: { market_prob: 0.75, stats_prob: 0.72, api_prob: 0.7,
            samples: { home_n: 8, away_n: 8, h2h_n: 3 } },
    };
    const cal = computeCalibration([]);
    const opts = { ...DEFAULT_SAFE, minMarketSettled: 0 };
    assert.equal(safeQualifies(row, opts, cal), safeQualifies({ ...row, tip_ai_verdict: 'confirm' }, opts, cal));
});

test('_tipFields still reports the veto (ledger + popover keep reading it)', () => {
    const rows = magicSortRows([{ api_id: 1, tip_market: '1X', tip_price: 1.4,
        tip_confidence: 0.8, tip_ai_verdict: 'veto' }], computeCalibration([]), 'sure');
    assert.equal(rows.length, 1); // it ranks, it does not sink out
});
```

Ensure the test file's import line includes every symbol used: `computeCalibration`, `scoreTip`, `STRATEGIES`, `safeQualifies`, `DEFAULT_SAFE`, `magicSortRows`.

- [x] **Step 2: Run tests to verify they fail**

Run: `npm test 2>&1 | grep -E "veto|fail "`
Expected: FAIL — the vetoed row scores `null` while the confirmed one scores a number.

- [x] **Step 3: Remove the veto from the scorer and the gates**

In `src/db/magic-rules.js:356`, change:

```javascript
    if (!tip || tip.vetoed) return null;
```
to:
```javascript
    // NOTE: tip.vetoed is deliberately NOT consulted (M4.1 spec 3.8). The AI veto
    // shows no discrimination on settled data (confirm 75.0% vs veto 72.7%, n=61),
    // so it must not shape ranking. It is still persisted + surfaced for the ledger.
    if (!tip) return null;
```

In `:448` (`safeQualifies`), change `if (!tip || tip.vetoed) return false;` to `if (!tip) return false;`.

In `:655`, change `if (tips.filter(t => !t.vetoed).length >= legs) eligibleDays++;` to `if (tips.length >= legs) eligibleDays++;`.

In `:663`, change `const pool = byDay.get(day).filter(t => !t.vetoed);` to `const pool = byDay.get(day);`.

Update the comment at `:353` and at `:629` to drop "AI-vetoed" from the sink/exclusion list. Leave `:48` (`vetoed: r.tip_ai_verdict === 'veto'`) intact.

- [x] **Step 4: Run tests to verify they pass**

Run: `npm test 2>&1 | tail -6`
Expected: PASS, and the whole suite stays green (506 + 3 new = 509).

- [x] **Step 5: Remove the web strike-through and the betslip exclusion**

In `web/src/components/DataTable.jsx`, delete the `const vetoed = ...` lines at `:281` and `:326` and every use, so the tip cell renders on `missed` alone:

```javascript
// Missed = red wholesale. The AI verdict is recorded but never styled: it shows
// no discrimination on settled data (M4.1 spec 3.8), so it must not shape what
// the user sees. The popover still spells the verdict out.
const missed = row.tip_outcome === 'miss';
```
```javascript
        <div className={`whitespace-nowrap ${missed ? 'text-miss' : ''}`}>
```
```javascript
            <span className={`font-semibold decoration-dotted underline-offset-2 group-hover/tip:underline ${missed ? '' : 'text-accent'}`}>{row.tip_market}</span>
            {pct && <span className={missed ? '' : _pctClass(row.tip_confidence)}> · {pct}</span>}
```

At `:332`, drop the `+ (vetoed ? ' - flagged for caution' : '')` clause from the tooltip.

In `web/src/components/BetslipPlayground.jsx:122`, change:
```javascript
            if (r.tip_market != null && r.tip_ai_verdict !== 'veto') unique.push(r);
```
to:
```javascript
            if (r.tip_market != null) unique.push(r);
```
and update the `:111` comment from "the table's non-vetoed tips" to "the table's tips".

- [x] **Step 6: Verify the build and the live table**

Run: `npm run build:web 2>&1 | tail -3`
Expected: `✓ built in ...` with no unresolved imports.

Restart `serve`, load the table, confirm no tip renders struck through and the magic sort no longer sinks 73.5% of rows.

- [x] **Step 7: Commit**

```bash
git add src/db/magic-rules.js web/src/components/DataTable.jsx web/src/components/BetslipPlayground.jsx tests/magic-rules.test.js
git commit -m "fix(tips): stop acting on the AI veto - no measured discrimination

Settled evidence: confirm 75.0% (n=28) vs veto 72.7% (n=33). The 2.3pp gap is
noise; the honest claim is no evidence of discrimination. Opening the AI faucet
made this live - 125 of 170 upcoming tips (73.5%) are now vetoed, and the veto
sank them in every magic sort, dropped them from the betslip pool, and struck
them through in the table.

The verdict is still persisted and surfaced (the ledger must be able to prove
what following the vetoes would have cost). hot=false on veto is unchanged -
different gate, different evidence base, out of scope. M4.1 spec 3.8."
```

---

### Task 2: Config keys + settings catalog entries

**Files:**
- Modify: `src/config.js` (new keys near the existing `HOTPICK_AI_*` block)
- Modify: `src/db/settings-rules.js` (catalog entries)
- Modify: `.env.example`
- Test: `tests/settings-rules.test.js`

**Interfaces:**
- Produces: `config.OPENROUTER_API_KEY`, `config.OPENROUTER_URL`, `config.OPENROUTER_MODEL`, `config.AI_ENRICH_ENABLED`, `config.AI_ENRICH_CAP`, `config.AI_ENRICH_CONCURRENCY`, `config.AI_BLIND_MODEL`, `config.AI_ANCHORED_MODEL`.

- [x] **Step 1: Add the config keys**

In `src/config.js`, add to `EnvSchema` (match the file's existing `boolStr`/`optionalStr` helpers):

```javascript
    // --- M4.1 AI enrichment (collection only - nothing feeds ranking) ---
    // Keys are secrets: .env ONLY, never the settings catalog.
    OPENROUTER_API_KEY: optionalStr(z.string().min(1).optional()),
    OPENROUTER_URL: z.string().default('https://openrouter.ai/api/v1'),
    // Pinned, non-Google by REQUIREMENT: reasoner independence is what the
    // consensus signal is built on - two Google models agreeing is Gemini
    // agreeing with itself. openrouter/auto and openrouter/free are auto-routers
    // that silently vary the model per fixture; they are disqualified.
    // Verified present in the live /api/v1/models list 2026-07-16.
    OPENROUTER_MODEL: z.string().default('openai/gpt-5.6-terra'),
    AI_ENRICH_ENABLED: boolStr('0'),
    AI_ENRICH_CAP: z.coerce.number().int().min(0).default(200),        // FIXTURES per run, not calls
    AI_ENRICH_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(4),
    AI_BLIND_MODEL: z.string().default(''),      // '' = provider default
    AI_ANCHORED_MODEL: z.string().default(''),   // '' = provider default
```

- [x] **Step 2: Add the live-editable catalog entries**

In `src/db/settings-rules.js`, add to the catalog (mirror the shape of the existing `SAFE_*` entries exactly — read the file first and copy the field names it uses):

```javascript
    AI_ENRICH_ENABLED: { type: 'bool', live: true, group: 'ai', label: 'AI enrichment on' },
    AI_ENRICH_CAP: { type: 'int', live: true, group: 'ai', min: 0, max: 2000, label: 'Fixtures enriched per run' },
    AI_ENRICH_CONCURRENCY: { type: 'int', live: true, group: 'ai', min: 1, max: 16, label: 'Enrichment concurrency' },
    OPENROUTER_MODEL: { type: 'string', live: true, group: 'ai', label: 'OpenRouter model (non-Google)' },
    AI_BLIND_MODEL: { type: 'string', live: true, group: 'ai', label: 'Blind reasoner model override' },
    AI_ANCHORED_MODEL: { type: 'string', live: true, group: 'ai', label: 'Anchored reasoner model override' },
```

**Do NOT add `OPENROUTER_API_KEY`** — the catalog excludes secrets by construction.

- [x] **Step 3: Assert the key stays out of the catalog**

In `tests/settings-rules.test.js`, add `'OPENROUTER_API_KEY'` to the existing secret-exclusion list (the test that already loops `HUMAN_TOKEN_SECRET`/`BONGA_API_SECRET`/`DB_PASSWORD` — note `HUMAN_TOKEN_SECRET` and `VITE_HUMAN_POW` are now dead keys and may be dropped from that list while you are here).

- [x] **Step 4: Run tests**

Run: `npm test 2>&1 | tail -6`
Expected: PASS, suite green.

- [x] **Step 5: Document the keys in `.env.example`**

Add beside the existing `GEMINI_API_KEY` block:

```
# --- M4.1 AI enrichment (collection only; nothing feeds ranking) ------------
#OPENROUTER_API_KEY=            # secret - .env ONLY, never the settings catalog
#OPENROUTER_URL=https://openrouter.ai/api/v1
#OPENROUTER_MODEL=openai/gpt-5.6-terra   # MUST be non-Google: two Google models agreeing is Gemini agreeing with itself.
                                         # openrouter/auto + openrouter/free are auto-routers (model varies per call) - disqualified.
#AI_ENRICH_ENABLED=0           # 1 = run the 3-call enrichment set per upcoming fixture
#AI_ENRICH_CAP=200             # FIXTURES per run (never truncates a fixture mid-set)
#AI_ENRICH_CONCURRENCY=4       # fixtures in flight; calls are network-bound, not DB-bound
#AI_BLIND_MODEL=               # blank = provider default
#AI_ANCHORED_MODEL=            # blank = provider default
```

- [x] **Step 6: Commit**

```bash
git add src/config.js src/db/settings-rules.js tests/settings-rules.test.js .env.example
git commit -m "feat(config): M4.1 AI-enrichment keys + live catalog entries

Keys are secrets (.env only); model + behaviour are admin-editable. The
OpenRouter model is pinned non-Google by requirement - reasoner independence is
what the consensus measurement rests on. Verified against the live model list."
```

---

### Task 3: Pure AI rules module

**Files:**
- Create: `src/db/ai-rules.js`
- Create: `tests/ai-rules.test.js`

**Interfaces:**
- Consumes: `config.*` keys from Task 2 — but **only via injected arguments**; this module imports zod ONLY (zero config/DB imports), per the house `*-rules.js` contract.
- Produces:
  - `FACT_SCHEMA_VER` (number, `1`)
  - `BLIND_MARKETS` (frozen array)
  - `buildBlindPrompt({ fixture, kickoff, league, home, away, h2h, facts })` → string
  - `buildAnchoredPrompt({ fixture, kickoff, league, tip, home, away, h2h, facts })` → string
  - `FactsPayload` (zod), `BlindPayload` (zod), `AnchoredPayload` (zod)
  - `normalizeProbabilities(obj)` → obj
  - `enrichModelTag({ model, grounded, promptVersion })` → string
  - `resolveTask(task, cfg)` → `{ provider, model, grounded }`

- [x] **Step 1: Write the failing tests**

Create `tests/ai-rules.test.js`:

```javascript
// Pure M4.1 enrichment rules (src/db/ai-rules.js): prompt builders, per-kind
// schemas, model-tag math, task->provider/model resolution. Zero network/DB.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    FACT_SCHEMA_VER, BLIND_MARKETS, buildBlindPrompt, buildAnchoredPrompt,
    FactsPayload, BlindPayload, normalizeProbabilities, enrichModelTag, resolveTask,
} from '../src/db/ai-rules.js';

const FIXTURE = {
    fixture: 'Arsenal - Chelsea', kickoff: '2026-07-20 18:00:00', league: 'Premier League',
    home: { n: 8, avgTotal: 2.9, gfAvg: 1.8, gaAvg: 1.1, bttsRate: 0.6 },
    away: { n: 8, avgTotal: 2.4, gfAvg: 1.2, gaAvg: 1.2, bttsRate: 0.5 },
    h2h: { n: 3, avgTotal: 3.1 },
};

// THE ANCHORING GUARD. The whole blind-vs-anchored measurement is void if a
// price or our tip leaks into the blind prompt.
test('buildBlindPrompt leaks no odds, no price and no tip', () => {
    const p = buildBlindPrompt(FIXTURE);
    for (const banned of ['odds', 'price', 'bookmaker', 'tip', 'break-even', 'vig']) {
        assert.ok(!p.toLowerCase().includes(banned), `blind prompt must not mention "${banned}"`);
    }
    assert.ok(p.includes('Arsenal - Chelsea'));
});

test('buildBlindPrompt asks for exactly the fixed market set', () => {
    const p = buildBlindPrompt(FIXTURE);
    for (const m of BLIND_MARKETS) assert.ok(p.includes(m), `blind prompt must ask about ${m}`);
});

test('buildAnchoredPrompt DOES carry the tip and price (that is the point)', () => {
    const p = buildAnchoredPrompt({ ...FIXTURE, tip: { market: '1X', price: 1.4 } });
    assert.ok(p.includes('1X'));
    assert.ok(p.includes('1.4'));
});

test('normalizeProbabilities renormalizes each family to 1 (never trust the model)', () => {
    const out = normalizeProbabilities({ 1: 0.5, X: 0.3, 2: 0.4, 'O 2.5': 0.6, 'U 2.5': 0.6, GG: 0.5, NG: 0.1 });
    assert.ok(Math.abs(out['1'] + out['X'] + out['2'] - 1) < 1e-9);
    assert.ok(Math.abs(out['O 2.5'] + out['U 2.5'] - 1) < 1e-9);
    assert.ok(Math.abs(out['GG'] + out['NG'] - 1) < 1e-9);
});

test('normalizeProbabilities leaves a family alone when it is absent or all-zero', () => {
    const out = normalizeProbabilities({ 1: 0, X: 0, 2: 0 });
    assert.deepEqual(out, { 1: null, X: null, 2: null });
});

test('FactsPayload distinguishes absent evidence from "no problem found"', () => {
    const parsed = FactsPayload.parse({});
    assert.equal(parsed.availability.home_out_count, null); // absent, NOT 0
    assert.equal(parsed.schema_ver, FACT_SCHEMA_VER);
});

test('FactsPayload tolerates unknown extra keys (the escape hatch)', () => {
    const parsed = FactsPayload.parse({ extra: { weather: 'storm' } });
    assert.deepEqual(parsed.extra, { weather: 'storm' });
});

test('BlindPayload rejects a probability outside 0..1 but rescales percentages', () => {
    assert.equal(BlindPayload.parse({ probabilities: { 1: 65 } }).probabilities['1'], 0.65);
    assert.throws(() => BlindPayload.parse({ probabilities: { 1: -1 } }));
});

test('enrichModelTag encodes model + grounding + prompt version', () => {
    assert.equal(enrichModelTag({ model: 'gemini-2.5-flash', grounded: true, promptVersion: 1 }),
        'gemini-2.5-flash+search#e1');
    assert.equal(enrichModelTag({ model: 'openai/gpt-5.6-terra', grounded: false, promptVersion: 1 }),
        'openai/gpt-5.6-terra#e1');
});

test('resolveTask routes facts+anchored to Gemini and the blind reasoner off-Google', () => {
    const cfg = { HOTPICK_AI_MODEL: 'gemini-2.5-flash', OPENROUTER_MODEL: 'openai/gpt-5.6-terra',
        HOTPICK_AI_WEB: 1, AI_BLIND_MODEL: '', AI_ANCHORED_MODEL: '' };
    assert.deepEqual(resolveTask('facts', cfg),
        { provider: 'gemini', model: 'gemini-2.5-flash', grounded: true });
    assert.deepEqual(resolveTask('blind', cfg),
        { provider: 'openrouter', model: 'openai/gpt-5.6-terra', grounded: false });
    assert.deepEqual(resolveTask('anchored', cfg),
        { provider: 'gemini', model: 'gemini-2.5-flash', grounded: true });
});

test('resolveTask honours per-task model overrides', () => {
    const cfg = { HOTPICK_AI_MODEL: 'gemini-2.5-flash', OPENROUTER_MODEL: 'openai/gpt-5.6-terra',
        HOTPICK_AI_WEB: 0, AI_BLIND_MODEL: 'qwen/qwen3.7-plus', AI_ANCHORED_MODEL: 'gemini-2.5-pro' };
    assert.equal(resolveTask('blind', cfg).model, 'qwen/qwen3.7-plus');
    assert.equal(resolveTask('anchored', cfg).model, 'gemini-2.5-pro');
    assert.equal(resolveTask('facts', cfg).grounded, false);
});

test('resolveTask throws on an unknown task (a typo must be loud)', () => {
    assert.throws(() => resolveTask('nonsense', {}), /unknown ai task/i);
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `node --test tests/ai-rules.test.js 2>&1 | tail -5`
Expected: FAIL — `Cannot find module '../src/db/ai-rules.js'`.

- [x] **Step 3: Write the implementation**

Create `src/db/ai-rules.js`:

```javascript
import { z } from 'zod';

// Pure M4.1 enrichment rules: prompt builders, per-kind payload schemas,
// model-tag math and task->provider/model resolution. Imports zod only - no
// config/.env/DB - so it is fully offline-testable, the same contract as every
// other src/db/*-rules.js module. src/ai/* owns the HTTP; this owns the words
// and the shapes.
//
// Collection only: nothing here feeds bestTip, confidence or any ranking.

// Bump to re-enrich upcoming fixtures (reuse is keyed on the model tag).
export const PROMPT_VERSION = 1;

// Bump when the fact payload gains a field. schema_ver + a JSON payload is the
// deliberate answer to "leave room for anything we may need later": a new fact
// costs a version bump, NOT a forward-only migration.
export const FACT_SCHEMA_VER = 1;

// A blind call has not seen our tip, so it cannot be asked about "our tip". It
// emits a distribution over this fixed set instead, comparable to any tip we
// later made. Families are normalized by us, never trusted from the model.
export const BLIND_MARKETS = Object.freeze(['1', 'X', '2', 'O 2.5', 'U 2.5', 'GG', 'NG']);
const FAMILIES = [['1', 'X', '2'], ['O 2.5', 'U 2.5'], ['GG', 'NG']];

const _team = (label, t) => `${label}: last ${t.n} games - avg total goals ${t.avgTotal},`
    + ` scored ${t.gfAvg}/game, conceded ${t.gaAvg}/game, both-teams-scored rate ${t.bttsRate}`;

const _facts = facts => (facts
    ? ['Verified context (from an earlier grounded research pass):', JSON.stringify(facts)]
    : []);

// BLIND: no odds, no price, no tip, no bookmaker - by construction. The moment
// a prompt mentions those, the model anchors, which is the exact bias being
// measured. tests/ai-rules.test.js asserts this directly.
export function buildBlindPrompt({ fixture, kickoff, league, home, away, h2h, facts }) {
    return [
        'You are a football analyst. Estimate outcome probabilities for the match',
        'below from the evidence given. Judge the match on its merits.',
        '',
        `Fixture: ${fixture}`,
        `League: ${league ?? 'unknown'}`,
        `Kickoff: ${kickoff}`,
        _team('Home', home),
        _team('Away', away),
        `Head-to-head: ${h2h?.n ? `last ${h2h.n} meetings - avg total goals ${h2h.avgTotal}` : 'no prior meetings known'}`,
        ..._facts(facts),
        '',
        'Estimate P for EVERY outcome below. 1 = home win, X = draw, 2 = away win,',
        '"O 2.5"/"U 2.5" = over/under 2.5 total goals, GG/NG = both teams score yes/no.',
        `Outcomes: ${BLIND_MARKETS.join(', ')}`,
        '',
        'Reply with ONLY a JSON object, no other text:',
        '{"probabilities":{"1":0.0-1.0,"X":0.0-1.0,"2":0.0-1.0,"O 2.5":0.0-1.0,',
        ' "U 2.5":0.0-1.0,"GG":0.0-1.0,"NG":0.0-1.0},',
        ' "reason":"one short sentence naming the decisive factor"}',
    ].join('\n');
}

// ANCHORED: sees everything - tip, price, stats, facts. anchored - blind on the
// same fixture and model is a PAIRED measurement of the anchoring effect.
export function buildAnchoredPrompt({ fixture, kickoff, league, tip, home, away, h2h, facts }) {
    return [
        'You are a football analyst reviewing one candidate bet.',
        '',
        `Fixture: ${fixture}`,
        `League: ${league ?? 'unknown'}`,
        `Kickoff: ${kickoff}`,
        _team('Home', home),
        _team('Away', away),
        `Head-to-head: ${h2h?.n ? `last ${h2h.n} meetings - avg total goals ${h2h.avgTotal}` : 'no prior meetings known'}`,
        ..._facts(facts),
        '',
        `Candidate bet: ${tip.market} at bookmaker price ${tip.price}.`,
        '',
        'Give your probability that this bet WINS, and read the public/market',
        'consensus: is the money concentrated on this outcome?',
        '',
        'Reply with ONLY a JSON object, no other text:',
        '{"probability":0.0-1.0,"consensus":"heavy_on"|"lean_on"|"neutral"|"lean_against"|"heavy_against",',
        ' "reason":"one short sentence naming the decisive factor"}',
    ].join('\n');
}

// Models reply in percentages despite a 0..1 contract; rescale 65 -> 0.65
// rather than discard an otherwise good answer. Mirrors src/ai-parse.js#_prob.
const _prob = z.preprocess(v => {
    if (v == null) return null;
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    return n > 1 && n <= 100 ? n / 100 : n;
}, z.number().min(0).max(1).nullable());

const _nn = z.number().nullish().transform(v => v ?? null);
const _ns = z.string().nullish().transform(v => v ?? null);
const _nb = z.boolean().nullish().transform(v => v ?? null);

// Fact payload v1. EVERY field nullable: absent evidence must stay
// distinguishable from "no problem found" - a 0 would assert a fact we never
// verified.
export const FactsPayload = z.object({
    availability: z.object({
        home_out_count: _nn, away_out_count: _nn,
        home_key_absences: z.array(z.string()).nullish().transform(v => v ?? null),
        away_key_absences: z.array(z.string()).nullish().transform(v => v ?? null),
        top_scorer_out: _nb, first_choice_gk_out: _nb,
    }).nullish().transform(v => v ?? {}).pipe(z.object({
        home_out_count: _nn, away_out_count: _nn,
        home_key_absences: z.array(z.string()).nullable().default(null),
        away_key_absences: z.array(z.string()).nullable().default(null),
        top_scorer_out: _nb.default(null), first_choice_gk_out: _nb.default(null),
    }).partial().transform(v => ({
        home_out_count: v.home_out_count ?? null, away_out_count: v.away_out_count ?? null,
        home_key_absences: v.home_key_absences ?? null, away_key_absences: v.away_key_absences ?? null,
        top_scorer_out: v.top_scorer_out ?? null, first_choice_gk_out: v.first_choice_gk_out ?? null,
    }))),
    motivation: z.object({
        home_stakes: _ns, away_stakes: _ns, rotation_risk: _ns,
    }).nullish().transform(v => ({
        home_stakes: v?.home_stakes ?? null, away_stakes: v?.away_stakes ?? null,
        rotation_risk: v?.rotation_risk ?? null,
    })),
    congestion: z.object({
        home_days_since_last: _nn, away_days_since_last: _nn, bigger_match_within_4d: _nb,
    }).nullish().transform(v => ({
        home_days_since_last: v?.home_days_since_last ?? null,
        away_days_since_last: v?.away_days_since_last ?? null,
        bigger_match_within_4d: v?.bigger_match_within_4d ?? null,
    })),
    lineup: z.object({
        xi_confirmed: _nb, manager_change_recent: _nb, gk_change: _nb,
    }).nullish().transform(v => ({
        xi_confirmed: v?.xi_confirmed ?? null,
        manager_change_recent: v?.manager_change_recent ?? null,
        gk_change: v?.gk_change ?? null,
    })),
    extra: z.record(z.string(), z.unknown()).nullish().transform(v => v ?? null),
}).partial().transform(v => ({
    schema_ver: FACT_SCHEMA_VER,
    availability: v.availability ?? { home_out_count: null, away_out_count: null,
        home_key_absences: null, away_key_absences: null, top_scorer_out: null, first_choice_gk_out: null },
    motivation: v.motivation ?? { home_stakes: null, away_stakes: null, rotation_risk: null },
    congestion: v.congestion ?? { home_days_since_last: null, away_days_since_last: null, bigger_match_within_4d: null },
    lineup: v.lineup ?? { xi_confirmed: null, manager_change_recent: null, gk_change: null },
    extra: v.extra ?? null,
}));

export const BlindPayload = z.object({
    probabilities: z.record(z.string(), _prob).nullish().transform(v => v ?? {}),
    reason: z.string().nullish().transform(v => v ?? ''),
});

export const AnchoredPayload = z.object({
    probability: _prob.optional().transform(v => v ?? null),
    consensus: z.string().nullish().transform(v => v ?? null),
    reason: z.string().nullish().transform(v => v ?? ''),
});

// Renormalize each family to sum 1. The model's raw numbers routinely do not.
// An absent or all-zero family stays null - we do NOT invent a uniform prior.
export function normalizeProbabilities(probs) {
    const out = { ...probs };
    for (const family of FAMILIES) {
        const present = family.filter(k => out[k] != null && Number.isFinite(Number(out[k])));
        if (!present.length) continue;
        const sum = present.reduce((a, k) => a + Number(out[k]), 0);
        for (const k of family) {
            if (out[k] == null) continue;
            out[k] = sum > 0 ? Math.round((Number(out[k]) / sum) * 10000) / 10000 : null;
        }
    }
    return out;
}

// Reuse is keyed on this tag, so switching model, grounding or prompt version
// re-enriches upcoming fixtures automatically. '#e<N>' keeps the enrichment
// namespace distinct from the adjudicator's '#p<N>'.
export function enrichModelTag({ model, grounded, promptVersion = PROMPT_VERSION }) {
    return `${model}${grounded ? '+search' : ''}#e${promptVersion}`;
}

// task -> { provider, model, grounded }. Facts are extracted ONCE by the
// grounded model; both reasoners then work identical evidence, so disagreement
// is reasoning difference rather than one model simply knowing more.
export function resolveTask(task, cfg) {
    const grounded = Boolean(cfg.HOTPICK_AI_WEB);
    if (task === 'facts') {
        return { provider: 'gemini', model: cfg.HOTPICK_AI_MODEL, grounded };
    }
    if (task === 'blind') {
        // Non-Google by requirement: reasoner independence is the property the
        // consensus signal rests on.
        return { provider: 'openrouter', model: cfg.AI_BLIND_MODEL || cfg.OPENROUTER_MODEL, grounded: false };
    }
    if (task === 'anchored') {
        return { provider: 'gemini', model: cfg.AI_ANCHORED_MODEL || cfg.HOTPICK_AI_MODEL, grounded };
    }
    throw new Error(`unknown ai task: ${task}`);
}
```

**Note for the implementer:** the `FactsPayload` nested-default plumbing above is fiddly. If the zod version in this repo makes a branch of it awkward, simplify it — the only contract the tests pin is: every field defaults to `null` (never `0`/`false`), unknown `extra` keys survive, and `schema_ver` is stamped. Keep it readable over clever.

- [x] **Step 4: Run tests to verify they pass**

Run: `node --test tests/ai-rules.test.js 2>&1 | tail -5`
Expected: PASS (13 tests).

- [x] **Step 5: Run the whole suite**

Run: `npm test 2>&1 | tail -6`
Expected: PASS, green.

- [x] **Step 6: Commit**

```bash
git add src/db/ai-rules.js tests/ai-rules.test.js
git commit -m "feat(ai): pure M4.1 enrichment rules (prompts, schemas, tags, routing)

Zero-import (zod only) per the house *-rules.js contract. The blind prompt is
asserted to leak no odds/price/tip - the anchored-minus-blind paired
measurement is void otherwise. Probability families are renormalized by us,
never trusted from the model; an absent family stays null rather than
inventing a uniform prior."
```

---

### Task 4: `fixture_ai_insights` table (migration batch 14)

**Files:**
- Create: `src/db/migrations/20260716000002_fixture_ai_insights.js`

**Interfaces:**
- Produces: table `fixture_ai_insights` with PK `(fixture_id, kind, provider)`.

- [x] **Step 1: Write the migration**

Create `src/db/migrations/20260716000002_fixture_ai_insights.js`:

```javascript
// M4.1 AI enrichment (spec 2026-07-16): AI becomes a measurable multi-signal
// evidence source instead of a boolean adjudicator. One row per
// (fixture, kind, provider); upserted while kickoff > NOW() and frozen after.
//
// payload is JSON + schema_ver rather than typed columns on purpose: a new
// fact field costs a version bump, NOT a forward-only migration.
//
// fixture_id is INT UNSIGNED to match fixtures.id (int(10) unsigned) and
// fixture_predictions.fixture_id - a BIGINT here fails the FK with errno 150.
export async function up(knex) {
    await knex.schema.createTable('fixture_ai_insights', t => {
        t.integer('fixture_id').unsigned().notNullable()
            .references('id').inTable('fixtures').onDelete('CASCADE');
        t.enu('kind', ['blind', 'anchored']).notNullable();
        t.string('provider', 32).notNullable();          // 'gemini' | 'openrouter'
        t.string('model_tag', 64).notNullable();         // incl. '+search' / '#e<N>'
        t.smallint('schema_ver').unsigned().notNullable();
        t.json('payload').notNullable();                 // facts + probabilities
        t.json('sources').nullable();                    // grounding citations
        t.timestamp('created_at').defaultTo(knex.fn.now());
        t.timestamp('updated_at').defaultTo(knex.raw('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'));
        t.primary(['fixture_id', 'kind', 'provider']);
    });
}

export async function down(knex) {
    await knex.schema.dropTableIfExists('fixture_ai_insights');
}
```

- [x] **Step 2: Apply it**

Run: `npm run migrate 2>&1 | tail -3`
Expected: `Batch 14 run: 1 migrations`

- [x] **Step 3: Verify the shape**

Run:
```bash
node -e "import('./src/db/connection.js').then(async ({db,closeDb})=>{const r=await db.raw('SHOW CREATE TABLE fixture_ai_insights');console.log(r[0][0]['Create Table']);await closeDb();});"
```
Expected: PK `(fixture_id, kind, provider)`, FK to `fixtures(id)` `ON DELETE CASCADE`, `payload` JSON NOT NULL.

- [x] **Step 4: Commit**

```bash
git add src/db/migrations/20260716000002_fixture_ai_insights.js
git commit -m "feat(db): fixture_ai_insights table (M4.1, batch 14)

JSON payload + schema_ver so a new fact field costs a version bump, not a
forward-only migration. fixture_id INT UNSIGNED to match fixtures.id."
```

---

### Task 5: Provider seam (`src/ai/`)

Directly mirrors `src/sms/index.js`, which already solved this shape (`PROVIDERS` map + one `getProvider()` swap point).

**Files:**
- Create: `src/ai/index.js`, `src/ai/gemini.js`, `src/ai/openrouter.js`
- Delete: `src/ai.js` (moved to `src/ai/gemini.js`)
- Modify: `src/hotpicks.js:10` (import path)
- Create: `tests/ai-provider.test.js`

**Interfaces:**
- Consumes: `resolveTask`, `enrichModelTag` (Task 3).
- Produces:
  - `src/ai/index.js`: re-exports today's public API unchanged — `aiEnabled()`, `aiModelTag()`, `adjudicateHotPick(...)`, `reviewTip(...)` — plus `getProvider(name)` and `callModel({ task, prompt, cfg })` → `{ text, sources }`.
  - `src/ai/gemini.js`: `complete({ model, prompt, grounded })` → `{ text, sources }`; still exports the adjudicators.
  - `src/ai/openrouter.js`: `complete({ model, prompt })` → `{ text, sources: [] }`.

- [x] **Step 1: Move the Gemini module (preserve behaviour exactly)**

```bash
git mv src/ai.js src/ai/gemini.js
```

In `src/ai/gemini.js`, fix the now-relative imports (the file moved one level deeper):

```javascript
import { config } from '../config.js';
import { parseAiReply } from '../ai-parse.js';
import { tipMarketLabel } from './../db/magic-rules.js';
```

Then add a generic completion export beside the existing adjudicators (reusing the same axios shape as `_adjudicate`, but returning raw text so the enrichment can parse per-kind):

```javascript
// Generic single completion for the M4.1 enrichment layer. Returns raw text +
// grounding citations; the caller applies its own per-kind zod schema.
// Throws on any failure - callers fail open, exactly like the adjudicators.
export async function complete({ model, prompt, grounded }) {
    const res = await axios.post(
        `${config.GEMINI_URL}/models/${model}:generateContent`,
        {
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0 },
            ...(grounded ? { tools: [{ google_search: {} }] } : {}),
        },
        {
            headers: { 'x-goog-api-key': config.GEMINI_API_KEY, 'Content-Type': 'application/json' },
            timeout: 60_000, // grounded calls run searches before answering
        },
    );
    return extractGeminiText(res.data);
}
```

- [x] **Step 2: Add the text extractor to `src/ai-parse.js`**

The existing `parseAiReply` decodes envelope→verdict in one step; enrichment needs envelope→text and applies its own schema. Add (and export) beside it, reusing `GeminiEnvelope`:

```javascript
// Envelope -> { text, sources }. The verdict-shaped sibling of parseAiReply,
// for callers that apply their own per-kind schema (M4.1 enrichment).
export function extractGeminiText(data) {
    const parsed = GeminiEnvelope.parse(data);
    const candidate = parsed.candidates[0];
    const text = (candidate.content?.parts ?? []).map(p => p.text ?? '').join('');
    const sources = (candidate.groundingMetadata?.groundingChunks ?? [])
        .map(c => c?.web)
        .filter(w => w && (w.uri || w.title))
        .map(w => ({ title: w.title ?? null, uri: w.uri ?? null }));
    return { text, sources };
}

// First JSON object in a reply (tolerates markdown code fences), parsed.
// Throws when there is none - callers fail open.
export function extractJson(text) {
    const m = /\{[\s\S]*\}/.exec(String(text));
    if (!m) throw new Error(`AI reply carried no JSON object: ${text}`);
    return JSON.parse(m[0]);
}
```

Import `extractGeminiText` in `src/ai/gemini.js`. Refactor `parseAiReply` to reuse `extractGeminiText` + `extractJson` (DRY — it currently inlines both).

- [x] **Step 3: Write the OpenRouter provider**

Create `src/ai/openrouter.js`:

```javascript
import axios from 'axios';
import { config } from '../config.js';
import { withRetry } from '../db/retry-rules.js';
import { isRetryableNetworkError } from '../db/net-rules.js';

// OpenRouter provider (OpenAI-compatible chat/completions). Used for the BLIND
// reasoner only, and pinned to a NON-Google model: two Google models agreeing
// is Gemini agreeing with itself, so reasoner independence is a correctness
// requirement of the experiment, not a preference.
//
// No grounding: OpenRouter has no google_search equivalent here, and the blind
// call deliberately works only the facts the grounded pass already extracted -
// which is what makes blind-vs-anchored a fair paired comparison.
//
// Transport retries reuse the shared network retry, exactly like src/sms/index.js
// (transient ECONNRESET/TLS self-heals). A bad reply is NOT retried - it is a
// model problem, not a transport one, and the caller fails open.
const RETRY = { tries: 3, base: 500, isRetryable: isRetryableNetworkError };

export function enabled() {
    return Boolean(config.OPENROUTER_API_KEY);
}

export async function complete({ model, prompt }) {
    const res = await withRetry(() => axios.post(
        `${config.OPENROUTER_URL}/chat/completions`,
        { model, messages: [{ role: 'user', content: prompt }], temperature: 0 },
        {
            headers: {
                Authorization: `Bearer ${config.OPENROUTER_API_KEY}`,
                'Content-Type': 'application/json',
            },
            timeout: 60_000,
        },
    ), RETRY);
    const text = res.data?.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || !text.trim()) {
        throw new Error('OpenRouter reply carried no message content');
    }
    return { text, sources: [] };
}
```

Wrap the Gemini `complete()` from Step 1 in the same `withRetry(...)`, with the same two imports. **Check `withRetry`'s real signature in `src/db/retry-rules.js` first** — it was written for DB writers; if its options differ from `{ tries, base, isRetryable }`, follow `src/sms/index.js`, which already calls it with `isRetryableNetworkError`.

- [x] **Step 4: Write the seam**

Create `src/ai/index.js`:

```javascript
import { config } from '../config.js';
import { resolveTask } from '../db/ai-rules.js';
import * as gemini from './gemini.js';
import * as openrouter from './openrouter.js';

// AI provider seam. ONE getProvider() swap point - directly mirrors
// src/sms/index.js, which already solved this shape. Adding a provider means
// implementing complete({ model, prompt, grounded }) -> { text, sources } and
// nothing else changes.
const PROVIDERS = { gemini, openrouter };

// Today's adjudicator API, re-exported unchanged so src/hotpicks.js keeps
// working exactly as before.
export { aiEnabled, aiModelTag, adjudicateHotPick, reviewTip } from './gemini.js';

export function getProvider(name) {
    const p = PROVIDERS[name];
    if (!p) throw new Error(`unknown ai provider: ${name}`);
    return p;
}

// Route one enrichment task to its provider+model. Throws on failure; callers
// fail open (the pipeline never depends on the AI being up).
export async function callModel({ task, prompt, cfg = config }) {
    const { provider, model, grounded } = resolveTask(task, cfg);
    return { ...(await getProvider(provider).complete({ model, prompt, grounded })), provider, model, grounded };
}
```

- [x] **Step 5: Repoint the consumer**

In `src/hotpicks.js:10`, change:
```javascript
import { aiEnabled, aiModelTag, adjudicateHotPick, reviewTip } from './ai.js';
```
to:
```javascript
import { aiEnabled, aiModelTag, adjudicateHotPick, reviewTip } from './ai/index.js';
```

Then check for any other importer:
```bash
grep -rn "from './ai.js'\|from '../ai.js'" src/ tests/ scripts/
```
Expected: no output. Repoint anything that appears.

- [x] **Step 6: Write the seam tests**

Create `tests/ai-provider.test.js`:

```javascript
// AI provider seam (src/ai/index.js) - routing + the fail-open contract.
// No network: providers are exercised through resolveTask, and the HTTP
// clients are not invoked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getProvider } from '../src/ai/index.js';
import { resolveTask } from '../src/db/ai-rules.js';

test('getProvider returns a provider exposing complete()', () => {
    for (const name of ['gemini', 'openrouter']) {
        assert.equal(typeof getProvider(name).complete, 'function');
    }
});

test('getProvider throws on an unknown provider (a typo must be loud)', () => {
    assert.throws(() => getProvider('nope'), /unknown ai provider/i);
});

test('the blind task never routes to a Google model (reasoner independence)', () => {
    const cfg = { HOTPICK_AI_MODEL: 'gemini-2.5-flash', OPENROUTER_MODEL: 'openai/gpt-5.6-terra',
        HOTPICK_AI_WEB: 1, AI_BLIND_MODEL: '', AI_ANCHORED_MODEL: '' };
    const blind = resolveTask('blind', cfg);
    assert.equal(blind.provider, 'openrouter');
    assert.ok(!/google|gemini|gemma/i.test(blind.model));
});

// Spec 4: retry classification. Transport faults self-heal; a model replying
// nonsense is NOT a transport fault and must not be retried (it would just
// re-bill the same bad answer).
test('retry classification: transport errors retry, bad replies do not', () => {
    assert.equal(isRetryableNetworkError({ code: 'ECONNRESET' }), true);
    assert.equal(isRetryableNetworkError(new Error('AI reply carried no JSON object: blah')), false);
});

// Spec 4: failures PROPAGATE out of callModel (the orchestrator's try/catch is
// what fails open). Routed through an unknown task so the assertion is fully
// OFFLINE - `npm test` must never touch the network, and a real
// OPENROUTER_API_KEY in .env would otherwise make this fire a live request.
test('callModel propagates a routing failure rather than resolving silently', async () => {
    await assert.rejects(() => callModel({ task: 'nonsense', prompt: 'x', cfg: {} }),
        /unknown ai task/i);
});
```

Add `callModel` and `isRetryableNetworkError` to the imports:
```javascript
import { getProvider, callModel } from '../src/ai/index.js';
import { isRetryableNetworkError } from '../src/db/net-rules.js';
```

**Do NOT write a test that calls a provider's `complete()`.** `tests/` is offline by contract (no DB, no live APIs) and `.env` carries real keys — such a test would bill real money and fail in CI. The orchestrator's try/catch is the real fail-open guarantee, and Task 8 Step 2 exercises it live.

- [x] **Step 7: Run the suite**

Run: `npm test 2>&1 | tail -6`
Expected: PASS, green — proving the `src/ai.js` → `src/ai/gemini.js` move broke nothing.

- [x] **Step 8: Verify the adjudicator path still really works**

The suite does not cover the live Gemini call. Run one real, cheap pass:

Run: `node src/index.js hotpicks 2>&1 | tail -3`
Expected: a `[+] hotpicks:` line with `AI tips: <n>/<n>/<n>` and NOT all errors. (Cached verdicts are reused, so this should be nearly free.)

- [x] **Step 9: Commit**

```bash
git add -A
git commit -m "refactor(ai): provider seam (src/ai/) mirroring the SMS seam

src/ai.js -> src/ai/gemini.js (behaviour identical, adjudicator API re-exported
unchanged); new src/ai/openrouter.js (OpenAI-compatible, pinned non-Google);
src/ai/index.js is the one getProvider() swap point. ai-parse gains
extractGeminiText/extractJson, which parseAiReply now reuses."
```

---

### Task 6: Enrichment orchestrator

**Files:**
- Create: `src/enrich.js`
- Create: `tests/enrich-rules.test.js`
- Modify: `src/db/ai-rules.js` (add `selectEnrichable`, `capFixtures`)

**Interfaces:**
- Consumes: `callModel` (Task 5), prompts/schemas (Task 3), the table (Task 4).
- Produces: `enrichFixtures()` → `{ fixtures, calls, written, errors, skipped }`.

- [x] **Step 1: Write the failing leakage + cap tests**

Add the pure helpers' tests to `tests/enrich-rules.test.js`:

```javascript
// M4.1 enrichment selection rules. The leakage assertion here is the
// highest-severity guard in the milestone: a grounded call on a played fixture
// google-searches the final score, and the failure is SILENT and FLATTERS.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectEnrichable, capFixtures } from '../src/db/ai-rules.js';

const NOW = new Date('2026-07-16T12:00:00Z').getTime();

test('selectEnrichable rejects every past-kickoff fixture (LEAKAGE GUARD)', () => {
    const rows = [
        { id: 1, kickoff: '2026-07-16T11:59:00Z' }, // 1 min ago - still leakage
        { id: 2, kickoff: '2026-07-16T12:00:00Z' }, // exactly now - not future
        { id: 3, kickoff: '2026-07-16T12:01:00Z' }, // future - the only legal one
    ];
    assert.deepEqual(selectEnrichable(rows, NOW).map(r => r.id), [3]);
});

test('selectEnrichable takes soonest-kickoff first', () => {
    const rows = [
        { id: 1, kickoff: '2026-07-18T12:00:00Z' },
        { id: 2, kickoff: '2026-07-17T12:00:00Z' },
        { id: 3, kickoff: '2026-07-16T18:00:00Z' },
    ];
    assert.deepEqual(selectEnrichable(rows, NOW).map(r => r.id), [3, 2, 1]);
});

test('capFixtures bounds FIXTURES, never truncating one mid-set', () => {
    const rows = [{ id: 1 }, { id: 2 }, { id: 3 }];
    assert.deepEqual(capFixtures(rows, 2).map(r => r.id), [1, 2]);
    assert.equal(capFixtures(rows, 0).length, 0);
    assert.equal(capFixtures(rows, 99).length, 3);
});
```

- [x] **Step 2: Run to verify it fails**

Run: `node --test tests/enrich-rules.test.js 2>&1 | tail -4`
Expected: FAIL — `selectEnrichable` is not exported.

- [x] **Step 3: Add the pure helpers**

Append to `src/db/ai-rules.js`:

```javascript
// THE invariant that protects everything: an AI call must never touch a
// past-kickoff fixture. A grounded call on a played match retrieves the final
// score - leakage that RESEMBLES brilliance, and fails silently. This is the
// same freeze idiom as fixture_prematch / tips / hot picks, kept pure so it is
// asserted by a test rather than trusted as a convention.
// Strictly greater-than: a fixture kicking off exactly now is NOT upcoming.
export function selectEnrichable(rows, now = Date.now()) {
    return rows
        .filter(r => new Date(r.kickoff).getTime() > now)
        .sort((a, b) => new Date(a.kickoff) - new Date(b.kickoff)); // soonest first
}

// Bound FIXTURES per run, not calls: one fixture always gets its full 3-call
// set or none. A blind with no anchored is useless for the paired measurement.
export function capFixtures(rows, cap) {
    return cap > 0 ? rows.slice(0, cap) : [];
}
```

- [x] **Step 4: Run to verify it passes**

Run: `node --test tests/enrich-rules.test.js 2>&1 | tail -4`
Expected: PASS (3 tests).

- [x] **Step 5: Write the orchestrator**

Create `src/enrich.js`:

```javascript
import { db } from './db/connection.js';
import { config } from './config.js';
import { effective } from './settings.js';
import { callModel } from './ai/index.js';
import { extractJson } from './ai-parse.js';
import { _batch } from './utils.js';
import {
    selectEnrichable, capFixtures, buildBlindPrompt, buildAnchoredPrompt,
    FactsPayload, BlindPayload, AnchoredPayload, normalizeProbabilities,
    enrichModelTag, resolveTask, FACT_SCHEMA_VER,
} from './db/ai-rules.js';

// M4.1 AI enrichment: three calls per upcoming fixture.
//   1. facts    - grounded Gemini extracts typed facts ONCE
//   2. blind    - a non-Google reasoner sees stats + those facts, NO odds/tip
//   3. anchored - Gemini sees everything, incl. our tip and its price
// Both reasoners work IDENTICAL evidence, so disagreement is reasoning
// difference rather than one model simply knowing more; anchored - blind on the
// same fixture is a PAIRED measurement of the anchoring effect.
//
// COLLECTION ONLY. Nothing here feeds bestTip, confidence or any ranking - that
// is M4.3, answered by replay, not by assertion.
//
// Fail-open throughout: an AI error never breaks the pipeline.

// Same freeze idiom as prematch/tips/hot picks. The kickoff > NOW() filter lives
// in pure ai-rules (selectEnrichable) so it is test-asserted, but we also bound
// it in SQL so a huge warehouse never lands in memory.
async function _loadTargets() {
    const rows = await db('fixtures as f')
        .whereNotNull('f.id')
        .where('f.kickoff', '>', db.raw('NOW()'))
        .leftJoin('fixture_predictions as fp', 'fp.fixture_id', 'f.id')
        .leftJoin('leagues as l', 'l.id', 'f.league_id')
        .select('f.id', 'f.kickoff', 'f.home_name', 'f.away_name', 'l.name as league',
            'fp.tip_market', 'fp.tip_price')
        .orderBy('f.kickoff', 'asc');
    return rows;
}

async function _existingTags(fixtureIds) {
    if (!fixtureIds.length) return new Map();
    const rows = await db('fixture_ai_insights').whereIn('fixture_id', fixtureIds)
        .select('fixture_id', 'kind', 'provider', 'model_tag');
    const map = new Map();
    for (const r of rows) map.set(`${r.fixture_id}:${r.kind}:${r.provider}`, r.model_tag);
    return map;
}

async function _upsert(row) {
    await db('fixture_ai_insights').insert(row).onConflict(['fixture_id', 'kind', 'provider']).merge([
        'model_tag', 'schema_ver', 'payload', 'sources', 'updated_at',
    ]);
}

// Reuse gate: skip a call whose stored row already carries the tag we WOULD
// write. Keyed on (fixture, kind, provider, model_tag), so switching model,
// grounding or prompt version re-enriches automatically and a steady-state
// rerun re-bills nothing. Same idiom as the adjudicator's verdict reuse.
function _alreadyFresh(kind, f, tags) {
    const { provider, model, grounded } = resolveTask(kind === 'blind' ? 'blind' : 'anchored', config);
    return tags.get(`${f.id}:${kind}:${provider}`) === enrichModelTag({ model, grounded });
}

// One fixture's full 3-call set. Returns { written, errors }.
async function _enrichOne(f, tags) {
    // Nothing to do -> spend NOTHING. Without this the grounded facts call (the
    // most expensive of the three) would re-bill on every sweep even when both
    // reasoners are already fresh.
    const needBlind = !_alreadyFresh('blind', f, tags);
    const needAnchored = f.tip_market != null && !_alreadyFresh('anchored', f, tags);
    if (!needBlind && !needAnchored) return { written: 0, errors: 0 };

    const stats = {
        fixture: `${f.home_name} - ${f.away_name}`,
        kickoff: f.kickoff, league: f.league,
        // Rolling aggregates are not required for v1 collection; the grounded
        // pass researches context, which is what the warehouse cannot see.
        home: { n: 0, avgTotal: null, gfAvg: null, gaAvg: null, bttsRate: null },
        away: { n: 0, avgTotal: null, gfAvg: null, gaAvg: null, bttsRate: null },
        h2h: { n: 0, avgTotal: null },
    };
    let written = 0, errors = 0, facts = null, sources = null;

    // 1. FACTS (grounded, once).
    try {
        const r = await callModel({ task: 'facts', prompt: _factsPrompt(stats) });
        facts = FactsPayload.parse(extractJson(r.text));
        sources = r.sources ?? null;
    } catch (e) {
        errors++;
        console.warn(`[enrich] facts failed for fixture ${f.id} (continuing unfactualized): ${e.message}`);
    }

    // 2. BLIND (non-Google; identical evidence, no odds/tip).
    // NB the reuse gate wraps the try - it must NOT `return`, or a fresh blind
    // would skip the anchored call below and leave the pair half-measured.
    if (needBlind) {
        try {
            const r = await callModel({ task: 'blind', prompt: buildBlindPrompt({ ...stats, facts }) });
            const p = BlindPayload.parse(extractJson(r.text));
            await _upsert({
                fixture_id: f.id, kind: 'blind', provider: r.provider,
                model_tag: enrichModelTag({ model: r.model, grounded: r.grounded }),
                schema_ver: FACT_SCHEMA_VER,
                payload: JSON.stringify({ facts, probabilities: normalizeProbabilities(p.probabilities), reason: p.reason }),
                sources: sources ? JSON.stringify(sources) : null,
            });
            written++;
        } catch (e) {
            errors++;
            console.warn(`[enrich] blind failed for fixture ${f.id}: ${e.message}`);
        }
    }

    // 3. ANCHORED (sees the tip + price; only meaningful when we HAVE a tip).
    if (needAnchored) {
        try {
            const r = await callModel({
                task: 'anchored',
                prompt: buildAnchoredPrompt({ ...stats, facts, tip: { market: f.tip_market, price: f.tip_price } }),
            });
            const p = AnchoredPayload.parse(extractJson(r.text));
            await _upsert({
                fixture_id: f.id, kind: 'anchored', provider: r.provider,
                model_tag: enrichModelTag({ model: r.model, grounded: r.grounded }),
                schema_ver: FACT_SCHEMA_VER,
                payload: JSON.stringify({ facts, probability: p.probability, consensus: p.consensus, reason: p.reason }),
                sources: r.sources?.length ? JSON.stringify(r.sources) : null,
            });
            written++;
        } catch (e) {
            errors++;
            console.warn(`[enrich] anchored failed for fixture ${f.id}: ${e.message}`);
        }
    }
    return { written, errors };
}

function _factsPrompt({ fixture, kickoff, league }) {
    return [
        'Research this football fixture and report ONLY verified facts.',
        '',
        `Fixture: ${fixture}`,
        `League: ${league ?? 'unknown'}`,
        `Kickoff: ${kickoff}`,
        '',
        'Use web search where available. NEVER assert anything you did not verify -',
        'leave a field out entirely rather than guessing. Absent evidence must stay',
        'distinguishable from "no problem found".',
        '',
        'Reply with ONLY a JSON object, no other text:',
        '{"availability":{"home_out_count":n,"away_out_count":n,',
        '  "home_key_absences":["name"],"away_key_absences":["name"],',
        '  "top_scorer_out":true|false,"first_choice_gk_out":true|false},',
        ' "motivation":{"home_stakes":"dead_rubber|must_win|title_race|relegation|secured|normal",',
        '  "away_stakes":"...","rotation_risk":"low|medium|high"},',
        ' "congestion":{"home_days_since_last":n,"away_days_since_last":n,',
        '  "bigger_match_within_4d":true|false},',
        ' "lineup":{"xi_confirmed":true|false,"manager_change_recent":true|false,"gk_change":true|false},',
        ' "extra":{}}',
    ].join('\n');
}

export async function enrichFixtures() {
    if (!effective('AI_ENRICH_ENABLED')) {
        console.debug('[enrich] AI_ENRICH_ENABLED off - nothing to do.');
        return { fixtures: 0, written: 0, errors: 0, skipped: 0 };
    }
    const all = await _loadTargets();
    // Pure guard, belt AND braces with the SQL filter above.
    const upcoming = selectEnrichable(all);
    const targets = capFixtures(upcoming, Number(effective('AI_ENRICH_CAP')));
    const tags = await _existingTags(targets.map(f => f.id));

    let written = 0, errors = 0;
    // Bounded concurrency: these are NETWORK calls, so the _batch(..., 1) rule
    // for DB writers (InnoDB deadlock avoidance) does not apply here.
    // _batch(list, each, parallel) - verified signature in src/utils.js:51.
    const results = await _batch(
        targets,
        f => _enrichOne(f, tags),
        Number(effective('AI_ENRICH_CONCURRENCY')),
    );
    for (const r of results) { written += r?.written ?? 0; errors += r?.errors ?? 0; }
    return { fixtures: targets.length, written, errors, skipped: upcoming.length - targets.length };
}
```

**Note for the implementer:** check `_batch`'s exact signature in `src/utils.js` before wiring it (thunks vs promises, arg order) and adapt. Also confirm the `fixtures` column names (`home_name`/`away_name`/`league_id`) against `src/db/records.js` — use whatever that file actually joins.

- [x] **Step 6: Run the suite**

Run: `npm test 2>&1 | tail -6`
Expected: PASS, green.

- [x] **Step 7: Commit**

```bash
git add src/enrich.js src/db/ai-rules.js tests/enrich-rules.test.js
git commit -m "feat(ai): M4.1 enrichment orchestrator (3 calls/fixture, collection only)

Grounded facts extracted once, then blind (no odds/tip) + anchored (everything)
work identical evidence - anchored minus blind is a paired anchoring
measurement. kickoff > NOW() is enforced in SQL AND in a test-asserted pure
guard: a grounded call on a played fixture retrieves the score, and that failure
is silent and flatters. Cap bounds FIXTURES so a set is never truncated
mid-fixture. Nothing feeds ranking."
```

---

### Task 7: CLI + pipeline wiring

**Files:**
- Modify: `src/index.js` (dispatch `enrich`)
- Modify: `src/pipeline.js` (step after hot picks)
- Modify: `CLAUDE.md` (commands + architecture)

**Interfaces:**
- Consumes: `enrichFixtures()` (Task 6).

- [x] **Step 1: Add the CLI action**

In `src/index.js`, mirror the existing `hotpicks` case:

```javascript
import { enrichFixtures } from './enrich.js';
// ...
    case 'enrich': {
        const r = await enrichFixtures();
        console.debug(`[+] enrich: ${r.fixtures} fixtures, ${r.written} insights written, ${r.errors} errors, ${r.skipped} over cap.`);
        break;
    }
```

Follow the file's actual dispatch shape (read it first — it closes the knex pool on exit for every action).

- [x] **Step 2: Add the pipeline step**

In `src/pipeline.js`, after the hot-picks step (`:92`), add:

```javascript
    _step('AI enrichment (upcoming correlated fixtures; collection only)');
    const e = await enrichFixtures();
    console.debug(`[+] enrich: ${e.fixtures} fixtures, ${e.written} insights, ${e.errors} errors.`);
```

with `import { enrichFixtures } from './enrich.js';` at the top. It goes AFTER hot picks because the anchored call needs the tip that `updateHotPicks()` writes.

- [x] **Step 3: Verify it is a no-op while disabled**

Run: `node src/index.js enrich 2>&1 | tail -2`
Expected: `[enrich] AI_ENRICH_ENABLED off - nothing to do.` and `[+] enrich: 0 fixtures, ...` — proving the default-off contract.

- [x] **Step 4: Document it**

In `CLAUDE.md`, add to the command list:
```
node src/index.js enrich          # M4.1: 3-call AI enrichment for upcoming correlated fixtures (collection only)
```
and add an architecture bullet for `src/enrich.js` + `src/ai/` + `src/db/ai-rules.js` + `fixture_ai_insights`, in the voice of the surrounding bullets. State plainly that nothing feeds ranking and that AI reviews cannot be backfilled.

- [x] **Step 5: Commit**

```bash
git add src/index.js src/pipeline.js CLAUDE.md
git commit -m "feat(cli): enrich action + pipeline step (after hot picks)

Runs after hot picks because the anchored call needs the tip updateHotPicks
writes. Off by default (AI_ENRICH_ENABLED)."
```

---

### Task 8: Live verification

Spec §4: "one real sweep, confirming rows land in `fixture_ai_insights` with both providers present and `sources` populated."

**Files:** none (verification only).

- [x] **Step 1: Confirm no `serve` is running**

Run: `netstat -ano | grep -E ":3001.*LISTENING" || echo "clear"`
Expected: `clear`. **A CLI sweep racing the scheduler's light pass deadlocks on the same rows** — stop `serve` first.

- [x] **Step 2: Run a small real sweep**

Run: `AI_ENRICH_ENABLED=1 AI_ENRICH_CAP=3 node src/index.js enrich 2>&1 | tail -5`
Expected: `[+] enrich: 3 fixtures, 5-6 insights written, 0 errors, N over cap.`

- [x] **Step 3: Verify what actually landed**

Run:
```bash
node -e "import('./src/db/connection.js').then(async ({db,closeDb})=>{
  const r = await db('fixture_ai_insights').select('fixture_id','kind','provider','model_tag','schema_ver')
    .select(db.raw('LENGTH(payload) payload_bytes'), db.raw('sources IS NOT NULL has_sources'));
  console.table(r);
  await closeDb();
});"
```
Expected: both `gemini` and `openrouter` present; `kind` both `blind` and `anchored`; `model_tag` carrying `#e1` (and `+search` on the Gemini rows); `has_sources` = 1 on at least one grounded row.

**If `openrouter` rows are missing:** the key is unset or the pinned model was deprecated. Re-verify against the live list before changing the default:
```bash
node -e "import('axios').then(async ({default:a})=>{const r=await a.get('https://openrouter.ai/api/v1/models');console.log(r.data.data.map(m=>m.id).filter(i=>/gpt-5|qwen3|llama-3.3/.test(i)).slice(0,10));});"
```

- [x] **Step 4: Prove the leakage guard holds in the real query**

Run:
```bash
node -e "import('./src/db/connection.js').then(async ({db,closeDb})=>{
  const r = await db('fixture_ai_insights as i').join('fixtures as f','f.id','i.fixture_id')
    .where('f.kickoff','<=',db.raw('NOW()')).count({leaked:'*'});
  console.log('rows enriched on a past-kickoff fixture (MUST be 0):', r[0].leaked);
  await closeDb();
});"
```
Expected: `0`. **Anything else is a leakage bug — stop and fix before continuing.**

- [x] **Step 5: Confirm reuse does not re-bill**

Run the SAME sweep again: `AI_ENRICH_ENABLED=1 AI_ENRICH_CAP=3 node src/index.js enrich 2>&1 | tail -2`

Expected: `[+] enrich: 3 fixtures, 0 insights written, 0 errors` — `_alreadyFresh` short-circuits every call because the stored `model_tag` matches what we would write. **A non-zero `written` here means reuse is broken and every sweep re-bills** — fix before continuing.

Then prove the tag actually invalidates: bump `PROMPT_VERSION` to `2` in `src/db/ai-rules.js`, re-run, confirm `written` climbs back to 5-6, then revert it to `1`.

- [x] **Step 6: Full suite + build**

Run: `npm test 2>&1 | tail -6 && npm run build:web 2>&1 | tail -2`
Expected: suite green, build clean.

- [x] **Step 7: Commit**

```bash
git add -A
git commit -m "test(ai): live-verify M4.1 enrichment sweep

Both providers land, sources populate on grounded rows, the leakage guard holds
(0 rows on past-kickoff fixtures), and reuse no longer re-bills."
```

---

## Notes carried from measurement (do not re-derive)

- **AI reviews cannot be backfilled.** `HOTPICK_AI_WEB=1` attaches google_search; pointed at a played fixture it retrieves the final score and "predicts" it perfectly. Collection is wall-clock-bound, not compute-bound — no budget or parallelism shortens it. This is why enrichment precedes the M4.2 mining harness (which needs no new data).
- **The faucet needs a puller.** AI reviews accrue ONLY via `updateHotPicks()` — the full sweep or `node src/index.js hotpicks`. The 15-min light pass calls `settleHotPicks()`, which is settle-only and never calls a model. A `serve` must actually be running for the daily full sweep to fire, or the faucet is dry no matter what `.env` says. (Found 2026-07-16: `tip_ai_review` had been frozen at 42 rows since 07-09.)
- **Live baseline, 2026-07-16 after the first open-faucet run:** `tip_ai_review` 42 → 210 rows; 170 tips reviewed (43 confirm / 125 veto / 2 error), 11 hot picks adjudicated. Two error modes seen and both failed open correctly: one reply whose `verdict` was outside `confirm|veto` (zod enum rejection), one 60s timeout.
- **M4.3 is ~1,800 rows away** and answers: is AI probability calibrated? does anchoring degrade it? is consensus an anti-signal (the founding thesis)? does model disagreement predict? Only survivors reach ranking, and only via replay evidence. Precedents for skepticism: X2 "+15% EV" **refuted**; the runner-up swap net-negative (+108/−128).
