# The Safety Net Protocol — realistic bankroll recovery

*Adopted 2026-07-09. Numbers below are measured from our own settled tips
(547 tips over 7 days, 2026-07-03 → 2026-07-09). Re-run
`node scripts/analyze-safe-tips.js` weekly and update this doc when the
numbers move.*

## The honest premise

No selection system guarantees profit, and **7 days is a thin sample** — every
percentage below carries wide error bars. What this protocol does is different
from chasing wins: it caps how wrong a bad week can go (small flat stakes, few
picks, short slips) while betting only where all our measured signals agree.
Recovery is a **multi-week grind of small edges**, not a sprint. The fastest
way to lose the remaining bankroll is to bet bigger to "catch up" — that is the
one move this protocol forbids.

## What the data says (as of 2026-07-09)

| Fact | Number |
|---|---|
| All settled tips | 547 over 7 days, **73.9%** hit rate |
| Safe pool (the 🛡 gates, backtested leave-one-day-out) | **94.4%** legs (17/18), 2.6 picks/day |
| 2-leg safe slips in the replay | **6/6 won** |
| 3-leg safe slips in the replay | 5/6 won |
| Best confidence any tip reaches | ~0.83 (the 1.2 price floor caps it) |
| Component-agreement sort streak (your observation) | avg 4.3 straight hits from the top, best 11 |

The Safe-only gates (Settings → 🛡 Safe only): at least two of the three
signals present (bookmaker odds, team form, expert data) with **none weak**
(weakest ≥ 0.65), price ≤ 1.6, ranked by market probability, **best 3 per
day**. Zero qualifiers on a day = no bet that day. That is the protocol
working, not failing.

## Why 2–3 legs, never more

A multi-bet only pays if EVERY leg wins, so leg probabilities multiply:

| True leg probability | 2 legs | 3 legs | 4 legs | 5 legs |
|---|---|---|---|---|
| 94% (replay rate) | 88% | 83% | 78% | 73% |
| 85% (pessimistic) | 72% | 61% | 52% | 44% |
| 80% (worst case) | 64% | 51% | 41% | 33% |

Break-even at typical safe prices (~1.25–1.30/leg): a 2-leg slip pays ~1.6×
(needs > 62% to profit), 3 legs ~2.0× (needs > 50%), 4 legs ~2.6× (needs
> 39%). At the replay's 94% legs everything is profitable — but at the
pessimistic 85% the margins on 4+ legs are already thin, and we must assume
the true rate sits below the replay. **2–3 legs keeps the slip profitable even
if the safe pool is 10 points worse than measured.** Longer slips look
exciting and quietly hand the edge back.

## The protocol (do exactly this)

1. **Turn on Settings → 🛡 Safe only.** The table shows at most 3 fixtures.
   The footer's `🛡 Safe: N` is the day's pool size.
2. **Bet ONE slip of the top 2–3 safe picks** (or two 2-leg slips when 3
   exist and you want smoother variance). Use the Slips playground — with
   Safe-only on, its candidate pool is already the safe picks in ranked order.
3. **Flat stake: 1–2% of the current bankroll per slip.** Recompute the stake
   as the bankroll moves (down AND up). Never more than 2 slips a day.
4. **Zero safe picks → no bet.** Skipped days cost nothing; forced bets cost
   the edge.
5. **Never chase.** After a losing slip the next stake is *smaller* (1–2% of
   the now-smaller bankroll), not bigger.
6. **Weekly:** run `node scripts/analyze-safe-tips.js`. Change the safe policy
   only when a combo beats the shipped row on leg rate AND volume AND slip
   survival — leg rate alone overfits. Apply it via `.env` (`SAFE_MAX_PER_DAY`,
   `SAFE_STRATEGY`, `SAFE_MIN_PARTS`, `SAFE_MIN_AGREEMENT`, `SAFE_MAX_PRICE`)
   and restart `npm run serve` — no code edit or web rebuild needed. The
   `DEFAULT_SAFE` literals in `src/db/magic-rules.js` are only the fallback.

`SAFE_MAX_PER_DAY` is the everyday knob: raise it to bet more of the day's
safe pool, lower it to bet only the very top. The gate thresholds
(`SAFE_MIN_*`, `SAFE_STRATEGY`, `SAFE_MAX_PRICE`) decide what *counts* as safe —
tune those from the script, not by feel.

## What to expect (variance honesty)

Even at a true 80% slip survival, losing 2 slips in a row happens 4% of the
time — roughly **once a month** at a slip a day. That is normal operation,
not a broken system. At 1–2% stakes a normal losing run costs 2–6% of
bankroll; that is the ceiling of pain this protocol allows. Compounding the
other way: a 2-leg slip at 1.65× odds winning ~75–85% of days grows the
bankroll roughly **5–10% per week** at 2% stakes — meaningful recovery in
2–3 months, not days. Any strategy promising faster is borrowing from the
downside.

## What we deliberately did NOT do (and why)

- **Swap tips for their runners-up.** Your observation was real — on 143
  misses the runner-up would have hit 108 times. But swapping everywhere also
  breaks 128 existing hits (net −20), and even confidence-close swaps are
  56W/72L. Zero runners-up "cover" their pick (the confidence sort makes
  covering markets the pick itself). The analysis script re-tests this weekly
  — if the verdict ever flips to positive, we revisit.
- **Gate on runner-up direction.** Aligned runners-up hit 83–90% but n=12 —
  far too thin to ship. Watch it in the script as data grows.
- **Trust raw confidence.** The replay shows blend confidence is NOT monotonic
  with winning (2/7 slip survival as a sort). Market probability + the
  empirical calibration are what the safe ranking uses instead.

## Growth path

The calibrated parts of the system (bucket posteriors, strategy replay,
these gates) improve mechanically as settled days accumulate. Revisit the
per-day cap (3 → 4–5) only after the safe pool holds ≥ 90% legs over 30+
replayable days. Until then: small, boring, repeatable.
