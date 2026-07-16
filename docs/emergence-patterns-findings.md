# Emergence-pattern mine — findings (2026-07-16)

*A pre-registered, read-only test of eight hypotheses against the settled tip
ledger. Every number below is reproducible via `node scripts/mine-patterns.js`.
No warehouse table was written, no API was called, no AI was billed. Scope and
triage: `docs/superpowers/specs/2026-07-16-m4.2-pattern-mining-design.md`.*

## One-paragraph truth

**No pattern earned anything, and the most valuable thing the mine found was a
flaw in the ledger rather than a signal in it.** Of the eight pre-registered
hypotheses, **two were adequately powered and both are REFUTED**; the other six
are **underpowered**, and three of those are underpowered in a specific and
important way — their populations **cannot occur any more**, because a live
config knob (`TIP_MIN_PRICE`) moved **1.20 → 1.35 on 2026-07-10** and
partitioned the ledger almost exactly on the temporal-OOS boundary. **Zero
`edge`s, zero `booster`s.** The two refutations are real results and one of them
matters: the founding contrarian thesis's sharpest testable form (the
"consensus trap": bookmaker and our own stats agreeing) shows **+0.7pp hit-rate
with a CI of [−5.4pp, +3.6pp] at n=335 — it does not discriminate.** The honest
summary is that the harness now works, the discipline held, and **the data
cannot yet answer these questions**: 14 tip-days, split in two by a policy
change at day 8. This agrees with the beat-the-book programme's own conclusion
that **calendar depth (≥30 match-days), not cleverness, is the binding
constraint**.

## The population

| | |
|---|---|
| Settled tips | **1,089** (773 hit / 316 miss) |
| Base hit rate | **71.0%** |
| Base flat EV | **−4.3%** (the vig — every pattern is measured against *this*, not against zero) |
| Match-days | **14** (2026-07-03 → 2026-07-16) |
| Temporal-OOS split | train 9 days (07-03…07-11) / test 5 days (07-12…07-16) |

## THE FINDING: the ledger is not one population

`TIP_MIN_PRICE` is a **live `.env` knob** (`.env:81`, currently `1.35`,
overriding the code default `1.2`). It was raised around 2026-07-10. Because
it decides which tips can be *generated at all*, the ledger contains two
different populations:

| Day | n | min price |
|---|---|---|
| 2026-07-03 | 7 | 1.20 |
| 2026-07-04 | 268 | 1.20 |
| 2026-07-05 | 173 | 1.20 |
| 2026-07-06 | 36 | 1.20 |
| 2026-07-07 | 31 | 1.20 |
| 2026-07-08 | 19 | 1.20 |
| 2026-07-09 | 58 | 1.20 |
| **2026-07-10** | 52 | **1.29** ← the change |
| 2026-07-11 | 152 | **1.35** |
| 2026-07-12 | 165 | 1.35 |
| 2026-07-13 | 31 | 1.35 |
| 2026-07-14 | 41 | 1.35 |
| 2026-07-15 | 41 | 1.35 |
| 2026-07-16 | 15 | 1.37 |

**Why this is a trap and not a curiosity.** The temporal-OOS split puts train at
07-03…07-11 and test at 07-12…07-16 — the regime changed at 07-10/11, i.e.
**almost exactly on the boundary**. So for any price-correlated hypothesis,
"train" is the old policy and "test" is the new one, and a naive out-of-sample
verdict measures **the config change, not the hypothesis**. PR-4a is the
clearest case: all **414** of its rows sit in train, because tips priced under
1.30 *can no longer be produced*. A harness that printed a bare `underpowered`
there would be lying by omission — "we could not test this" and "this failed"
are different claims.

**Both fixes are shipped.** `evaluatePattern` now distinguishes *population
absent from the test window* from ordinary thinness, and
`scripts/mine-patterns.js` prints a **POLICY-REGIME WARNING** with per-day
minimum prices on every run. A future knob change can never silently confound a
mine again.

## Results

Verbatim from `node scripts/mine-patterns.js` (BH-FDR q=0.10, 1,000
day-clustered bootstrap draws, volume floor train ≥ 100 / test ≥ 40):

| id | n | train | test | prec | base | lift | lift-CI | p | medP | flatEV | BH | class |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| PR-1-cascade-o15 | 101 | 64 | 37 | 70.3% | 71.0% | −0.7pp | [−8.1, +10.4] | 0.408 | 1.44 | +0.3% | n | underpowered |
| PR-2a-straddle | 27 | 12 | 15 | 70.4% | 71.0% | −0.6pp | [−11.3, +30.0] | 0.399 | 1.50 | +6.6% | n | underpowered |
| PR-2b-concord | 114 | 86 | 28 | 74.6% | 71.0% | **+3.6pp** | [−5.0, +10.4] | 0.245 | 1.37 | +2.6% | n | underpowered |
| PR-2c-confidence-gap | 220 | 139 | 81 | 70.5% | 71.0% | −0.5pp | [−7.1, +6.4] | 0.479 | 1.37 | −3.8% | n | **refuted** |
| PR-3-thin-evidence | 14 | 14 | 0 | 71.4% | 71.0% | +0.4pp | [−2.5, +0.0] | 1.000 | 1.23 | −11.0% | n | underpowered¹ |
| PR-4a-short-price | 414 | 414 | 0 | 74.9% | 71.0% | +3.9pp | [−3.9, +3.0] | 0.393 | 1.23 | −7.3% | n | underpowered¹ |
| PR-4b-low-spread | 335 | 254 | 81 | 71.6% | 71.0% | +0.7pp | [−5.4, +3.6] | 0.565 | 1.32 | −5.1% | n | **refuted** |
| PR-4c-ai-verdict | 33 | 33 | 0 | 72.7% | 71.0% | +1.7pp | [−15.5, +12.5] | 0.585 | 1.21 | −11.0% | n | underpowered¹ (ship-ineligible) |

¹ **population absent from the test window** — legislated out of existence by
the `TIP_MIN_PRICE` change (PR-3, PR-4a) or by the AI reviews stopping after
2026-07-09 (PR-4c). Not a failed test; an untestable one.

**Nothing survived BH-FDR.** Every class is `underpowered` or `refuted`.

## Per-hypothesis verdicts

### PR-1 — O/U cascade ladder: **directionally confirmed, economically unproven**

*Claim:* a fixture we tip `O 2.5` clears the lower line `O 1.5` far more often
than the `O 2.5` tip itself lands.

*Measured:* of **101** `O 2.5` tips, the tip landed **70.3%** but the fixture
cleared `O 1.5` **85.1%**. **The observation is real: +14.8pp of survival by
laddering down.**

*But it does not follow that laddering is worth doing.* Survival is not profit.
Break-even at 85.1% needs a price ≥ **1.175**, and `O 1.5` is a **live −5.4%
loser** (`docs/precursor-patterns.md`) precisely because it prices around there.
This is the project's signature trap — real lift living below the bettable
floor — and the class for it is `unbettable`, not `edge`. **To resolve it we
must attach `O 1.5`'s real stored price at those 101 fixtures and compute the
laddered EV directly.** That is a bounded follow-up, not a conclusion: this mine
did not do it, so PR-1's *economic* claim is **open**, not confirmed.

The generic table row for PR-1 measures the O 2.5 **tip**, not the ladder — the
claim is about a different market than the tip, so it cannot ride the generic
tip-hit path. That is why its row reads −0.7pp while the detail block reads
85.1%. They are answering different questions.

### PR-2a — Straddle configuration: **underpowered (n=27)**

*Claim:* runners-up containing both `O k` and `U k` for the same line k ⇒ the
blend is torn about that line ⇒ high-scoring game.

*Measured:* n=27 (12 train / 15 test), hit 70.4% vs base 71.0%. Flat EV +6.6%
looks tempting and **means nothing at n=27** — the lift CI is [−11.3pp,
+30.0pp], wide enough to contain almost any truth. The straddle configuration
is simply **rare**: 27 of 1,089 tips. **Not evidence of absence.** Re-test when
the ledger is deeper.

### PR-2b — Concord configuration: **underpowered, but the most promising thing here (n=114)**

*Claim:* when winner and both runners-up share one market family, the blend is
confident about the *dimension* and its tip should land more often.

*Measured:* hit **74.6%** vs base 71.0% (**+3.6pp**), flat EV **+2.6%** vs the
book's −4.3%, median price 1.37. It **just misses** the volume floor (train 86 /
100) and its lift CI [−5.0pp, +10.4pp] still spans zero, so it is **not a
result** — but it is the only pattern pointing the right way on both hit-rate
*and* EV. **This is the one to re-test first** as days accrue. It is explicitly
**not** ship-eligible today.

### PR-2c — Confidence gap: **REFUTED (adequately powered, n=220)**

*Claim:* a winner clearing its nearest rival by ≥0.10 confidence reflects a
decisive blend and should land more often.

*Measured:* hit **70.5%** vs base 71.0% — **−0.5pp**, lift CI [−7.1pp, +6.4pp],
flat EV −3.8%. **A decisive-looking blend is worth nothing.** This is a clean,
well-powered refutation and it is consistent with the project's existing finding
that raw confidence is not monotonic with winning (`src/db/magic-rules.js`).

### PR-3 — Thin evidence: **untestable (n=14)**

*Claim:* misses concentrate on thin-evidence fixtures.

*Measured:* only **14** of 1,089 settled tips are thin (either side < 6 games) —
because the generation floor (`minGames=5`) already excludes them. The
population barely exists, and all 14 sit inside train. **The avoid-rule this
hypothesis proposed is already enforced upstream at generation time**, which is
why there is nothing left to mine. That is a satisfying null: the guard works.

### PR-4a — Short price: **untestable on this ledger (n=414, all in train)**

*Claim (the founding thesis, bluntest form):* the shortest, most public-favoured
tips underperform what their price demands.

*Measured:* tips priced < 1.30 hit **74.9%** (vs base 71.0%, **+3.9pp**) yet
return **−7.3% flat EV** vs the book's −4.3%. **Directionally this is exactly
what the thesis predicts** — they win *more often* and *lose more money*, which
is the definition of a favourite trap.

**But it cannot be tested here and the number must not be trusted.** All 414 rows
are pre-2026-07-10; `TIP_MIN_PRICE=1.35` means this population no longer exists.
There is no out-of-sample window, so the OOS control — the one that killed "X2
+15% EV" — never ran. Treat +3.9pp / −7.3% as **suggestive of the thesis and
formally unproven**.

*Also note the confound within the confound:* short price and low spread are not
independent (a tip both the book and our stats love is short **because** they
agree). PR-4a and PR-4b are two views of one underlying variable, not two
witnesses.

### PR-4b — Low-spread consensus trap: **REFUTED (adequately powered, n=335)**

This is the founding contrarian thesis in its **sharpest and best-powered
testable form**, and the result deserves plain language.

*Claim:* when the bookmaker and our own stats **agree** (|market_prob −
stats_prob| ≤ 0.05 — the consensus trap), the tip underperforms its price
relative to tips where our stats dissent.

*Measured:* consensus-trap tips hit **71.6%** vs base **71.0%** — **+0.7pp**,
lift CI **[−5.4pp, +3.6pp]**, p=0.565. **Agreement does not predict failure.**
On EV they run **−5.1% vs the book's −4.3%**, i.e. very slightly worse — but
that gap is fully explained by price (agreement ⇒ shorter price ⇒ worse EV), not
by an independent consensus effect.

**What this does and does not say.** It does *not* say your observation is
imaginary — you have a real winning slip from the Safe-only filter, and the v1
adjudicator's contradiction-vetoes really did measure net-negative. What it says
is narrower and firmer: **on 335 settled tips, market-vs-stats agreement carries
no discrimination we can detect.** If a consensus anti-signal exists in this
warehouse, it is *not* visible through this lens at this depth. The AI lens
(PR-4c) is the other candidate and it has n=33.

### PR-4c — AI verdict: **untestable as pre-declared (n=33)**

Registered *in advance* as underpowered, and it was: **33** vetoed settled tips,
all before 2026-07-09 (AI reviews stopped after that date), so zero in the test
window. Hit 72.7% vs base 71.0%, CI [−15.5pp, +12.5pp] — uninformative by
construction. **Ship-ineligible until n ≥ 300**, exactly as registered. The
value of registering it now is that when the sample arrives the test is already
on the record rather than fitted to it.

## H5 — the golden-longshot spotter: refuted before it was built

Dropped during scoping, not mined. The user's observation — bookmakers misprice
glamour longshots (a 20x home win that lands) — is real as an anecdote and
**inverted as a statistic**. 1X2 outcome rate by offered price across all
settled correlated fixtures:

| Price band | n | wins | rate | avg price | flat EV |
|---|---|---|---|---|---|
| <2 | 966 | 610 | 63.1% | 1.57 | −0.9% |
| 2–3 | 1,061 | 407 | 38.4% | 2.49 | −4.4% |
| 3–5 | 1,959 | 471 | 24.0% | 3.78 | −9.2% |
| 5–10 | 562 | 77 | 13.7% | 6.37 | −12.7% |
| **≥10** | **153** | **2** | **1.3%** | 16.04 | **≈ −79%** |

The ≥10x band went **2-for-153**. That is the **favourite-longshot bias**, the
most replicated finding in sports-betting economics: books shade longshots
hardest precisely *because* punters chase the memorable 20x winner. It is the
worst-priced region of the board, and **with two positive examples no
discriminator can be fitted, let alone validated** — a "spotter" here would fit
noise to two games and badge a −79% EV surface.

**This corroborates the contrarian thesis rather than refuting it, aimed the
other way.** "Where public money concentrates, the price gets worse" is exactly
what −79% on the glamour bet looks like. *Reopen if the ≥10x band ever accrues
≥30 winners.*

## What earns an M4.2b ship

Applying the spec's four gates: **nothing.** No pattern is pre-registered *and*
OOS-surviving *and* BH-rejected *and* live-LODO-validated. Explicitly:

| Pattern | Why it does not ship |
|---|---|
| PR-2b concord | Most promising (+3.6pp, +2.6% EV) but underpowered; CI spans zero |
| PR-1 cascade | Survival real (+14.8pp) but its priced EV was never computed |
| PR-4a short price | Suggestive but untestable — no OOS window exists |
| PR-2c, PR-4b | Refuted with adequate power |
| PR-2a, PR-3, PR-4c | Underpowered / untestable |

**Carried debt (unchanged, still M4.2b's opening inventory).**
`docs/precursor-patterns.md` produced **three OOS-validated boosters that were
never shipped** — `DEFAULT_SAFE`/`hasSufficientStats` still contain no form-gap,
competitive-league-O2.5, or U3.5-support gate:

1. Strong-home-favourite: home last-7 PPG − away last-7 PPG ≥ 1.0 → 1X (OOS 83.2%, lift +15.5pp [11.2, 18.6])
2. Competitive-league O 2.5 at both-teams over-rate ≥ 0.75 (OOS 73.4%, lift +14.9pp [11.8, 19.1])
3. Deep-Under U 3.5 at support ≥ 0.7 (OOS 71.2%, lift +9.7pp [7.9, 11.3])

These remain the **best-evidenced candidates in the project** and still require
live-ledger LODO validation before shipping — warehouse precision has already
proven anti-correlated with live ROI once (`docs/sure-win-analysis.md`).

## Sample-size caveats — read before acting

- **14 tip-days, and effectively 9 + 5 split by a policy change.** The
  beat-the-book C3 bar is **≥30 independent match-days**; `docs/beat-the-book-roadmap.md`
  already concluded that **calendar time, not fetching or cleverness, is the
  binding constraint**. This mine independently confirms it.
- **Only 2 of 8 hypotheses cleared the volume floor.** Six "underpowered"
  verdicts are **not evidence of absence** — they are evidence that we asked
  too early.
- **The regime change is not repaired, only detected.** Restricting to a single
  regime leaves either 644 tips / 8 days (old) or 445 / 6 (new) — neither
  supports a powered OOS test. Nothing here can fix that but waiting.
- The volume floor (train ≥ 100 / test ≥ 40) is **lower** than the precursor
  mine's (200/80) because the tip ledger is 1,089 rows rather than 16,518.
  That is reduced power, recorded honestly rather than hidden.

## Next actions (in order of expected value)

1. **Let the calendar run.** Every hypothesis here is data-starved, and the
   pipeline already accrues ~1 day/day for free.
2. **Stop moving `TIP_MIN_PRICE` mid-experiment**, or record the change date so
   mines can regime-split deliberately rather than discover it after the fact.
   This knob change silently cost the ability to test PR-4a.
3. **Compute PR-1's laddered EV** — attach `O 1.5`'s real price at the 101
   `O 2.5`-tipped fixtures. Bounded, and it closes the one hypothesis whose
   descriptive claim actually held.
4. **Re-test PR-2b first** when train ≥ 100 — the only pattern pointing the
   right way on both hit-rate and EV.
5. **M4.2b: validate and ship the three precursor boosters** via LODO on the
   live ledger. They are better evidenced than anything this mine produced.

## Reproduce

```
node scripts/mine-patterns.js       # the mine (read-only; prints the regime warning)
npm test                            # tests/mine-rules.test.js - offline, no DB
```

Pure rules: `src/db/mine-rules.js`. Hypotheses are pre-registered in that
module's `PRE_REGISTERED` constant, committed (`36c05f9`…) **before** the mine
was ever run — that is what makes these results evidence rather than a fishing
trip.
