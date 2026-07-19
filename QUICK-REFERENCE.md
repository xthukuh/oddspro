# QUICK-REFERENCE

> Command/action sequences only. The WHY lives in `docs/engine/` (system bible); per-file
> architecture in `CLAUDE.md`; verified ops playbooks in `docs/agents/toolset.md`.
> **Commands or routines changed? Update this file in the SAME commit** — full triggers
> table: `docs/engine/00-README.md`.

## 1. Development

### 1.1 Prerequisites

- Node **20+** (prose requirement — no `engines` field by design; lockfiles gitignored).
- Docker with a MariaDB/MySQL container on host **:3306** — must pre-exist and is
  auto-detected (no compose file or canonical container name in the repo; pass
  `--container <name>` to scripts when detection fails).
- Windows/PowerShell 5.1 quirks (no `&&`, BOM traps): `docs/agents/toolset.md` §2.

### 1.2 Fresh clone → running

```sh
git clone <repo> && cd oddspro
npm install
cp .env.example .env      # REQUIRED: DB_*, X_APISPORTS_KEY. Set PIN_PEPPER BEFORE migrate.
                          # Local dev: AUTO_REFRESH_ENABLED=0 (no background scraping/API spend)
npm run migrate           # forward-only; seeds admin +254799944004 (PIN = ADMIN_SEED_PIN, default 0000)
npm --prefix web install
npm run serve             # API :3001 (serves web/dist when built)
cd web && npm run dev     # frontend dev :5173, proxies /api → :3001   (or: npm run build:web)
```

### 1.3 Everyday commands

Semantics authority: `CLAUDE.md` `## Commands` (names duplicated here, annotations never).

| Command | Does |
|---|---|
| `npm run start [-- days]` | full pipeline sweep, today..+3 days |
| `npm run serve` | API :3001 + in-process schedulers |
| `npm run build:web` | React build → `web/dist/` |
| `cd web && npm run dev` | frontend dev server :5173 |
| `npm test` | offline node:test suite (< 2s, no DB/APIs) |
| `npm run migrate` / `migrate:make <name>` | apply / scaffold migrations |
| `npm run package:deploy` | release zips — see §2.2 |

`node src/index.js <action> [date]` (idempotent; `[date]` defaults today):

| Action | Does |
|---|---|
| `betpawa` / `betika` | scrape odds → DB, auto-link |
| `fixtures` | canonical fixtures → DB, auto-link |
| `results` | settle finals, complete matches |
| `link [provider]` | correlate matches ↔ fixtures |
| `stats` / `standings` / `history` / `prematch` / `predictions` | deep data (fetch-once) |
| `hotpicks` | settle + recompute picks/tips (bills NO AI) |
| `aireview` | drain pending AI verdicts once |
| `enrich` | AI enrichment (BILLED; full-sweep-only) |
| `performance` | flat-stake ROI / hit-rate report |
| `export [date]` | CSV → `tmp/` |
| `geo` | visitor-IP geo backfill pass |
| `sms balance\|delivery <id>\|send <phone> <text>` | SMS provider ops |

Analysis-script chooser (backtests, mines, scorecards): `docs/agents/toolset.md` §4.

### 1.4 Dev routines — in this order

1. **After pulling backend changes:** restart `npm run serve` (a stale process holds :3001
   with old code).
2. **Manual sweep on a machine running serve:** stop serve (or `AUTO_REFRESH_ENABLED=0`) →
   `npm run start` → restart serve. Two writers = InnoDB gap-lock deadlocks.
3. **Before touching `DEFAULT_SAFE`:** `node scripts/analyze-safe-tips.js` (weekly cadence
   regardless).
4. **Cache clearing:** `?refresh=1` recomputes `/api/magic-sort` ONLY; records freshness =
   `data_version` bump (light pass) or the `REFRESH_CACHE_MINUTES` window; restart serve to
   drop the in-memory response memo.

### 1.5 Dev health checks — in this order

1. `npm test` — trust the live count, not doc snapshots.
2. `GET http://127.0.0.1:3001/api/refresh` — `data_version` + `last_success` freshness.
3. Tail `logs/auto-refresh.log` — recent `light ok` lines.
4. No `./.HALT` file present.

## 2. Production

### 2.1 Prerequisites

On `main` only; versions bumped in **both** `package.json` + `web/package.json` (lockstep);
cPanel access. Deep guide: `docs/DEPLOYMENT.md` §2–3 (one-time host setup lives there).

### 2.2 Release build — in this order

```sh
# 1. bump version: package.json + web/package.json (user decision)
npm test
npm run build:web
npm run package:deploy    # [-- --export-db] adds a gzipped DB dump, same timestamp
```

Produces `release/oddspro-app_<ts>.zip` + `oddspro-web_<ts>.zip`; refuses off-`main`;
idempotently tags `v<version>` at HEAD and pushes the tag (existing tag not at HEAD = loud
"bump the version" warning).

### 2.3 Production config (host `.env`)

| Knob | Setting |
|---|---|
| `MIGRATE_ON_BOOT=1` | Restart self-runs migrations, fail-fast (the no-SSH migration path) |
| `PIN_PEPPER` | Set BEFORE the first migrate/restart; **NEVER rotate** (invalidates every PIN) |
| `API_HOST=127.0.0.1`, `DB_POOL_MAX=3`, `DEBUG=0` | shared-host posture |
| `AUTO_FULL_AT` (EAT), `AUTO_LIGHT_MINUTES` | in-process refresh cadence |
| `SMS_ENABLED=1` + `BONGA_*` | required for real sign-ups (off = codes log server-side) |
| `VITE_SHOW_DETAILS=0` | build-time: hides tip internals in the prod bundle |
| Bot protection (opt-in) | `docs/DEPLOYMENT.md` §8 |

### 2.4 Deploy — in this order (detail: `docs/DEPLOYMENT.md` §4–5)

1. Upload + extract app zip → Application Root; web zip → `public_html`.
2. cPanel **Run NPM Install** — only if dependencies changed.
3. **Restart** (with `MIGRATE_ON_BOOT=1` this applies any new migration first).
4. Smoke test (§2.5).

### 2.5 Post-deploy smoke test — in this order

1. `GET /api/refresh` — fresh `data_version` / `last_success`.
2. `GET /api/columns` — catalog loads fast (an index regression shows here first).
3. `GET /api/visits/daily-unique` — public counter answers.
4. `logs/auto-refresh.log` gains `light ok` lines (proves the process stays resident).
5. Web page title shows the new version.

### 2.6 Production routines

| Routine | Command / action |
|---|---|
| Daily sweep | in-process (serve); optional cron backup ≥ 1h from `AUTO_FULL_AT` — Windows task `oddspro-pipeline` 08:00 / `scripts/pipeline-cron.sh` |
| Cron-only host | run `node src/index.js aireview` after each sweep (else AI verdicts stop) |
| Emergency stop | create `.HALT` in the app root — running serve exits ≤ ~30s, boot refused; delete to resume |
| Scheduled maintenance window | Admin → Dashboard "Maintenance" card (or Admin → Settings group `maintenance`): toggle + EAT start/end + message. Guests: banner pre-window, full-screen notice + API 503 during; admins/bearers bypass; auto-expires at end (M14) |
| User management (rescue a user) | Admin → Users: disable/enable, unlock, manual phone-verify (SMS-failure fallback), force PIN change, Reset PIN → temp PIN shown ONCE (user must change it at next sign-in). Self-disable/demote and last-admin removal are blocked (M8). Self-service alternative: Forgot PIN below (M13) |
| Forgot PIN (self-service) | Sign-in → "Forgot your PIN?" → code to the phone (falls back to the account's STORED email when SMS delivery verifiably fails) → new PIN + auto sign-in; every prior session is revoked (M13) |
| Email OTP fallback | Verify / PIN-change / Forgot-PIN codes can go by email when SMS can't deliver. `MAIL_MAILER=log` (default) prints emails to the server console (dev); `smtp` sends via .env `MAIL_*` creds. Admin → Settings group `Email` holds only the switch (M13) |
| DB backup | `node scripts/db-export.js [--container <name>]` → `backups/` (**mariadb-dump, never mysqldump**; phpMyAdmin-ready) |
| Changed-pepper recovery | `node scripts/reset-users.js --yes` (**DESTRUCTIVE** — wipes all users; dry-run without `--yes`) |
| Rollback | `docs/DEPLOYMENT.md` §5 |

## 3. Critical warnings & best practices

| Warning | Why |
|---|---|
| Run exactly ONE `npm run serve` | a second writer process gap-lock-deadlocks on the same odds rows |
| Restart serve after every backend pull | stale process serves old code; a web 500 usually means the API is down/stale |
| Never edit an applied migration | forward-only; add a new one |
| Never rotate `PIN_PEPPER` casually | invalidates every stored PIN (deliberate global reset only) |
| Releases/tags from `main` only | `package:deploy` enforces; versions bump root + web in lockstep |
| Never move a live generation knob (`TIP_MIN_PRICE`, `SAFE_*`) mid-experiment undated — change it via Admin → Settings so `admin_audit` dates it (M6); a raw `.env` move still needs a dated `docs/memory-bank.md` note | it partitions the measurement ledger (the 2026-07-10 lesson) |
| Never touch `DEFAULT_SAFE` without a fresh `analyze-safe-tips.js` run | the gates are LODO-tuned, not opinions |
| DARK switches (`AI_INJECTION_PREAMBLE`, `AI_CONSENSUS_*`) need an explicit user go BEFORE flipping; flip them in Admin → Settings (group `ai-dark`) so `admin_audit` dates the change (M6 — replaced the manual memory-bank note) | AI regime changes must be attributable |
| `scripts/reset-users.js` is DESTRUCTIVE | wipes all users/sessions/prefs |
| Frozen ledger / fetch-once: never rewrite settled rows or refetch immutable data | the scoreboard is honest by construction — `docs/engine/02-DATA-PIPELINE.md` |
| Odds market identity = `type_name`, never `type_id` | Betika reuses ids across different markets |
| Secrets live in `.env` only | never in git |

## 4. Definitions

> Wording authority for user-facing terms is `web/src/glossary.js` (the in-app Help
> glossary, test-enforced against `tipMarketLabel()`); this table **indexes** those terms
> and adds developer-only lingo. On conflict, `glossary.js` wins. Signal/skip badge wording:
> `web/src/components/TipPopover.jsx` (`SIGNAL_LABEL`, `skipLabel`).

**Market codes** (1X2, 1X/X2/12, O/U, GG/NG, DNB1/DNB2, TT, ODD/EVEN): canonical
plain-language definitions live in `web/src/glossary.js`; canonical display names in
`tipMarketLabel()` (`src/db/magic-rules.js`).

### Pricing & value

| Term | Meaning (mechanism) | Source |
|---|---|---|
| Odds / price | decimal payout multiplier; `1/price` = implied probability incl. vig | `glossary.js` |
| Overround (vig) | `sum(1/price)` over a full market book; tip books accepted only inside [1.01, 1.30] | `src/db/tip-rules.js` `bookIntegrity` |
| Devig / fair probability | renormalize implied probabilities to sum to 1 | `goals-rules.js` `impliedProbability`, `tip-rules.js` `_devig` |
| Edge | `confidence × price − 1` — an EV *proxy* for bucketing/ordering, not a profit claim | `magic-rules.js` / `perf-rules.js` |
| Flat-stake EV / ROI | profit at 1 unit per settled pick; honest overall ≈ **−3%** (no +EV market) | `perf-rules.js`, `docs/research/` |
| Break-even rate | `1 / avg price` — the hit-rate a price class must beat to profit | `perf-rules.js` |
| `TIP_MIN_PRICE` | 1.2 generation floor — sub-1.20 "sure things" pay too little to matter | `tip-rules.js` |

### Prediction & selection

| Term | Meaning (mechanism) | Source |
|---|---|---|
| Canonical fixture | the API-Football record every bookmaker match correlates to (`matches.fixture_id`) | `docs/engine/02-DATA-PIPELINE.md` |
| Tip | best-supported outcome across 7 families; confidence = 0.6 market + 0.3 stats + 0.1 API | `tip-rules.js`, `docs/engine/04-PREDICTIONS.md` |
| Hot pick 🔥 | binary Over-2.5 flag — all 9 gates passed; precision over recall | `goals-rules.js`, `docs/engine/04-PREDICTIONS.md` |
| Fairness pairing | both teams judged over the SAME window length, capped at the smaller side | `goals-rules.js` |
| Freeze at kickoff | `kickoff > NOW()` selection — past rows are never selected, hence never rewritten | `docs/engine/02-DATA-PIPELINE.md` |
| hit / miss / void | settled outcomes; void = DNB draw push (stake returned, excluded from rates) | `tip-rules.js` `tipOutcome` |
| Blend / parts | the components present in a tip's confidence (market/stats/api) | `tip-rules.js` |
| `safePrior` | market's live hit-rate beta-shrunk (k=20) toward its `WAREHOUSE_WLO` anchor | `magic-rules.js` |
| `sure` (strategy) | default sort = `safePrior × confidence` — win probability, NOT profit | `magic-rules.js`, `docs/engine/05-RANKING.md` |
| Sure bets ⭐ | top-10/day list, Safe-gated but ranked by `estimateLegProb` — **not** the `sure` strategy | `magic-rules.js`, `docs/engine/05-RANKING.md` |
| Safe pool 🛡 | `safeQualifies` gates (parts/agreement/price/stats/maturity) + top-3/day | `magic-rules.js` |
| `estimateLegProb` | `bucketPosterior ?? confidence`, clamped [0.05, 0.98] — the slip survival number | `magic-rules.js` |
| Unbettable | pattern-mine class: real statistical lift priced below 1.20 — lift you cannot buy | `mine-rules.js` |

### Statistics & measurement

| Term | Meaning (mechanism) | Source |
|---|---|---|
| LODO | leave-one-day-out replay — day D is scored with calibration built without D | `magic-rules.js` `simulateStrategies` |
| Temporal OOS | train on older days, test on the newest — no future leakage | `mine-rules.js`, backtest scripts |
| Beta shrinkage | `(hits + k·prior) / (n + k)` — thin buckets pulled toward the prior | `magic-rules.js` |
| BH-FDR | Benjamini-Hochberg false-discovery control across pattern hypotheses | `mine-rules.js` |
| Day-clustered CI | bootstrap resamples DAYS, not rows — same-day tips are correlated | `mine-rules.js` |
| Brier | mean squared error of stated probabilities (AI calibration health) | `scripts/ai-scorecard.js` |
| edge / booster / refuted / underpowered | pattern-verdict vocabulary (closed class); booster = real lift, no profit; edge = clears break-even at real prices (**never found**) | `mine-rules.js` |
| Policy regime | the config epoch a measurement ran under; a mid-window knob move splits the ledger | `scripts/mine-patterns.js` warning |
| `WAREHOUSE_WLO` | per-market warehouse temporal-OOS hit-rate anchors feeding `safePrior` | `magic-rules.js` |
| `ai_impact` / saved | what following the AI vetoes was worth (vetoed picks settle but leave the headline rate) | `perf-rules.js` |

### Operations & data

| Term | Meaning (mechanism) | Source |
|---|---|---|
| Light pass / full sweep | 10-min today-only refresh vs the daily 12-step pipeline | `docs/engine/01-SYSTEM.md` |
| `data_version` | monotonic counter bumped on successful refresh; keys the response cache + client silent reloads | `src/auto-refresh.js` |
| Fetch-once | immutable API detail fetched at most once per fixture (`*_fetched_at` flags) | `docs/engine/02-DATA-PIPELINE.md` |
| Stale odds | vanished market kept flagged with its last-seen price (it IS the historical price) | `src/db/odds-diff.js` |
| Alias | learned provider→canonical team/league name mapping — the linking fast-path | `src/link.js` |
| DARK switch | shipped-but-off AI regime knob; flipping needs an explicit go, dated by `admin_audit` (M6) | `AGENTS.md` |
| Model tag (`#pN`) | model+grounding+prompt-version identity keying AI-verdict reuse | `src/ai/adjudicators.js` |
| `AiGuardOpen` | the AI run guard tripped (wall-clock budget / breaker) — remaining calls refuse instantly | `src/ai/harness.js` |
| `.HALT` | kill-switch file: presence stops a running serve and blocks boot | `src/halt.js` |
| EAT day | Africa/Nairobi calendar day (+03:00 pinned in the SQL session) — daily caps and schedules key on it | `knexfile.js` |
| Gap lock | InnoDB range lock behind the single-writer rule | `toolset.md` §3.2 |
| `PIN_PEPPER` | server-wide scrypt secret; set before first migrate, never rotate | `src/auth-rules.js` |
| `MIGRATE_ON_BOOT` | serve self-migrates before listening — the no-SSH host migration path | `src/server.js` |
