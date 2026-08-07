# Perf caching + engine generation-2 iteration - design

Owner-directed 2026-08-08 (chat). Two workstreams; deploy to the LIVE v1.4.0
host at the end, gated on the owner's explicit green light (warn to stop the
server first; re-tag the commit head).

## Workstream A - server output caching + perf

Goal: fast and snappy client experience. Audit the existing layers first
(makeJsonCache on /api/records + /api/columns keyed on data_version; sendJson
ETag/gzip on /api/magic-sort; browser no-cache + 304s), then extend where
measurement says it pays:
- Cache the remaining hot reads (magic-sort payload compute, performance,
  daily-slip today/timeline, hotpicks) on the same data_version idiom where
  per-response freshness is not load-bearing.
- Static asset caching for web/dist (hashed filenames = immutable).
- Payload slimming where sanctioned: the guest records payload's market-key
  tail and the details-tier AI-review JSON a VITE_SHOW_DETAILS=0 build never
  renders (CLAUDE.md flags both as decision-gated - this session decides).
- Measure before/after (cold/warm ms, bytes over the wire).

## Workstream B - engine gen-2: analyze, learn from misses, iterate

Honesty rails (unchanged, from the charter + what-works): walk-forward only -
backfilled outcomes are used ONLY to settle tip-vs-outcome and feed the error
signal for the NEXT generation; no hindsight leaks into any pick. Anti-mirage
discipline: worst-half train fitness + an untouched test tail; deterministic
searches; no re-rolling. Honest labels on every reported rate.

1. **Refresh data** (full sweep, running in background).
2. **Diagnose**: hit-vs-miss pattern comparison over the settled tip ledger
   (3,866+ settled) and the daily-slip timeline (37 days): price bands,
   market families, confidence, sample depth, overround, league context,
   day-of-week, provider - existing pure labellers only (no new taxonomy).
3. **Contradiction audit**: locate and eliminate logical contradictions
   (e.g. O 1.5 and U 1.5 surfacing for the same fixture across surfaces:
   tip column vs banker leg vs safe pool vs daily slip). The safest-market
   surface must be self-consistent by construction.
4. **Gen-2 iteration harness**: extend the deterministic coordinate-descent
   machinery (evolve-daily-slip.js idiom) to >= 100 walk-forward generations
   with an error-feedback loop (misses reweight the next generation).
   Objectives per the owner: the TOP-3 SAFEST MARKETS per day, prioritizing
   legs at >= 1.5 odds (high-value easy wins); day-level survival stays the
   fitness core (success-bar-daily-2x).
5. **Owner checkpoint**: present found patterns + the proposed algorithm
   overhaul BEFORE baking any regime change (the owner granted overhaul
   freedom, gated on their approval of the concrete change).
6. **Bake + verify**: tests, honest replay report, docs.

## Deploy (end of session, owner-gated)

Exhaust mods first. Then: warn the owner to stop the live server, deploy via
scripts/deploy-remote.js (--db subsequent mode + --app + --web), restart,
smoke test. Re-tag v1.4.0 (or bump - owner's call) at the shipped HEAD.
