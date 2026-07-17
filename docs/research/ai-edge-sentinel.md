# AI edge sentinel — first light (2026-07-16)

*`scripts/edge-sentinel.js` is the standing M4.3 instrument over
`fixture_ai_insights`. Read-only, no AI/API calls, runs in seconds — run it
after any sweep and it measures whatever has accumulated. This doc records why
it exists and what its FIRST run (256 enriched fixtures, the day the faucet
opened) already found. Numbers below will be superseded by later runs; the
first-light anchoring result stands on its own.*

## Why this instrument exists

M4.2b (`docs/research/m4.2b-booster-validation-and-value-edge.md`) closed every route
from **rolling stats** to profit, with the mechanistic reason: rolling stats
carry **zero information orthogonal to the devigged market price**. The one
untested signal source is the M4.1 AI enrichment (grounded facts + a blind
non-Google reasoner + an anchored reasoner), whose faucet opened 2026-07-16
(`AI_ENRICH_ENABLED=1` persistent, ~296 fixtures backfilled).

The unorthodox part: **two of its three measurements need no outcomes at
all**, so learning started the same evening — not after the ~1,800-row
accumulation M4.3 was scoped to wait for.

## M1 — the anchoring effect (no outcomes needed): **FIRST REAL DISCOVERY**

Both reasoners see byte-identical evidence (`ai-rules.js` builds both prompts
from one projection); the only asymmetry is that the anchored call also sees
our tip and its price. `anchored − blind` on the same fixture is therefore a
paired measurement of pure anchoring bias.

First read, 35 comparable pairs (tips inside the blind menu):

| measurement | value |
|---|---|
| anchored − blind, mean | **+16.1pp** (median +15.0, sd 5.0) |
| pairs where anchored > blind | **100%** (35/35) |
| blind − devigged market, mean | **+0.5pp** (the blind AI ~agrees with the market on our tips) |
| anchored − devigged market, mean | **+16.5pp** (the anchored AI is inflated 16pp above it) |

**Read: the anchored reasoner is close to purely sycophantic — shown a bet, it
rates the bet ~16pp above both the market and its own blind twin, on identical
evidence, in every single pair.** This retroactively *explains* the M4.1
finding that tip-AI verdicts showed no discrimination (confirm 75.0% vs veto
72.7%, n=61): an anchored adjudicator confirms whatever it is shown, so its
verdicts carry almost no signal. It also hardens two standing decisions:
- the M4.1 §3.8 removal of the veto from ranking/display was right for a
  deeper reason than "no measured discrimination";
- **anchored probabilities must never be used as signal** in M4.3 — the blind
  stream is the only clean one.

*(Caveat: 35 pairs from one generation day; the size may drift. The direction —
100% positive, tight sd — is already decisive for the two decisions above.)*

## M2 — blind-AI dissent from the market (no outcomes needed): **precondition PRESENT**

`blind_prob − devigged_market_prob` per market, 1,752 (fixture,market) rows:
overall sd **±9.3pp**, **26%** of rows dissent by >10pp. The blind AI does
**not** simply re-derive the price — unlike rolling stats, whose "dissent" was
pure noise, there is real disagreement here for outcomes to arbitrate.
Notable systematic lean: home win mean **−3.3pp** / away win **+2.6pp** — the
blind AI leans against home-favouritism relative to the books. Dissent is
*necessary* for an edge, never sufficient; M3 decides who is right.

## M3 — dissent calibration (needs settled fixtures): **accumulating**

The probe-value-edge H-CALIB test with signal = blind AI: does positive dissent
predict `realized − devig` > 0? First run: 31 settled rows over 1 day —
**underpowered (floor 40), directional only**; the middle bins lean the right
way (−20pp at negative dissent, +23pp at positive, n=8/7) but the extremes flip
on single rows. **No conclusion. Watch this table as settled rows accumulate**
(~1 enriched day settles per day). If the high-dissent bin climbs where rolling
stats stayed flat, that is the first market-orthogonal signal this project has
ever seen — then a pre-registered EV test follows, never an insta-ship.

## PR-1 laddered EV — closed the same evening (REFUTED)

`scripts/close-pr1-ladder-ev.js` attached `O 1.5`'s real price at the 101
`O 2.5`-tip fixtures (72 priced): clear rate 83.3% but **median price 1.13** vs
the 1.175 break-even → laddered flat EV **−5.9%** (recent regime −6.1%);
bettable ≥1.20 slice n=5. The pre-registered "sub-1.20 trap" expectation was
exactly right. Detail in `docs/research/emergence-patterns-findings.md` (PR-1 section,
resolution appended).

## Cadence

```
node scripts/edge-sentinel.js        # any time; after the daily sweep is natural
```
M1/M2 firm up as the faucet fills (~296 fixtures/day enriched, reuse-gated);
M3 gains ~30–100 settled rows/day. Revisit for a real verdict once M3 clears
the 40-row floor across ≥5 settled days; the JSON artifact
(`tmp/edge-sentinel.json`) stamps each run.
