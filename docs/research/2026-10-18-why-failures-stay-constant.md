# Why the failure rate never moves, and what the data can still do (2026-10-18)

Read-only replay over the 2026-10-15 live extraction (`tmp/sharp/fx.ndjson`: 28,843 settled
linked fixtures, 850,372 priced legs, 106 days 2026-07-02..10-15) plus the Pinnacle capture
`tmp/pin/pin.ndjson` (2,856 fixtures, 2026-10-11..10-21). Script and full output:
`tmp/analysis/f-verdict/` (gitignored; the script imports the production pure modules, so
every number is in the engine's own vocabulary and settle rules). The local Docker DB was
down at the time; nothing here needed it.

## The finding in one line

The hit rate IS the price. Our models converge on the bookmaker's number and cannot pass it,
so the loss stays at the margin no matter how much data accrues. The only measured lever is
an external sharper price (Pinnacle), and that one is suggestive, not proven.

## 1. Constancy

| month | legs | hit | devig | ROI, all | band 1.50-2.20 legs | hit | devig | ROI |
|---|---|---|---|---|---|---|---|---|
| 2026-07 | 123,053 | 50.0% | 50.0% | -10.2% | 33,816 | 51.6% | 51.5% | -7.5% |
| 2026-08 | 281,267 | 50.0% | 50.0% | -10.6% | 78,454 | 51.6% | 51.5% | -7.5% |
| 2026-09 | 302,097 | 50.0% | 50.0% | -11.2% | 84,729 | 51.3% | 51.4% | -8.1% |
| 2026-10 | 133,425 | 50.0% | 50.0% | -11.0% | 37,819 | 51.5% | 51.3% | -8.0% |

Realized hit equals the devigged price to a tenth of a point every month. The ROI is the
overround and nothing else: about -7.5% in the Pick band, -10.5% across the whole board.

## 2. Learning curve (walk-forward, day by day, log loss, lower is better)

| month | legs seen before | devig | our calibration | + league cells | Pick claimed | Pick hit |
|---|---|---|---|---|---|---|
| 2026-07 | 0 | 0.54980 | 0.54834 | 0.54969 | 59.4% | 59.1% |
| 2026-08 | 124,633 | 0.54970 | 0.54872 | 0.55049 | 59.5% | 59.2% |
| 2026-09 | 409,406 | 0.54780 | 0.54623 | 0.54801 | 59.3% | 59.0% |
| 2026-10 | 715,275 | 0.55119 | 0.54972 | 0.55145 | 59.2% | 60.6% |

The calibrator beats the raw devig by 0.3% of log loss from its first month and the gap
does not grow with 715k more observations. A finer model (league-specific cells) is worse
every month: more resolution finds noise, not signal. The Pick claims 59% and hits 59%.
Calibration is solved; it was never the problem.

## 3. Slice search with a frozen test tail (train < 2026-09-01, test after)

1,543 slices across six families (family x price band, market x band, country, league,
kickoff hour x family, country x family). Slices with train ROI above +2% number about what
a shuffled-outcome null produces (3 vs 3.6, 8 vs 4.3, 0 vs 0.3, 2 vs 2.4, 4 vs 1.8, 29 vs
4.7), and their pooled test ROI is -6.6% to -16.0%, indistinguishable from the null's.
Nothing in our own history transfers forward.

## 4. The two Kenyan books carry the same information

Line shopping (best of BetPawa and Betika) lifts band ROI from -7.2% to -6.5%. Using one
book's devig as the other's reference finds nothing (n 739, -6.6% at ratio >= 1.00; worse
above). Both books copy the same upstream price.

## 5. Day level

The shipped top-3 Pick card lands 2 or more on 52% to 80% of days by month, claimed per leg
65%, realized 55% to 71%: noise around the claim at 90 legs a month. A 2x card of the four
safest legs (average 2.10x) claims 45% survival and realizes 53 / 52 / 37 / 20% by month.
A fair 2.1x card survives about 45% of days whatever the legs are. An assured daily 2x does
not exist at these prices; no selection rule in sections 2 to 4 moves it.

## 6. Pinnacle as the external reference (1,001 joined fixtures, 10-11..10-15)

| rule | n | ROI | 95% half-width | hit | Pinnacle claimed |
|---|---|---|---|---|---|
| every band leg | 5,387 | -7.4% | 2.4% | 52.2% | |
| price x Pinnacle fair >= 1.00 | 263 | +5.4% | 11.1% | 57.4% | 56.9% |
| price x Pinnacle fair >= 1.02 | 151 | +12.0% | 14.9% | 59.6% | 57.1% |
| price x Pinnacle fair >= 1.04 | 99 | +20.2% | 18.2% | 63.6% | 58.0% |
| all legs, ratio >= 1.04 | 597 | +7.5% | 14.7% | 34.2% | 35.5% |
| band, ratio < 0.98 | 4,884 | -8.5% | 2.5% | | |

A shuffled-within-cell null reaches the +12.0% in 4 of 200 draws. Pinnacle's own claimed
probability matches the realized hit on the selected legs, so the Kenyan price is simply
wrong on them. This is the only rule in the whole study where selection moves the realized
hit rate away from the Kenyan price in the paying direction. It agrees with the 2026-10-18
lens (different extraction, 10-11..10-17: +19.8% at >= 1.02, n 133) and with the published
closing-line result (Kaunitz, Zhong and Kreiner 2017, positive ROI when a soft book's price
exceeds the sharp consensus). Caveats: five overlapping days; the interval includes zero;
96 of the 1,001 fixtures carry a Pinnacle update at or after kickoff, so the captured
number is close to the closing line, which is sharper than what a T-3h or T-1h capture
will see.

## 7. Power

Per-leg return sd is 0.905 in the band. A +2% edge needs about 7,900 legs for a 95% lower
bound above zero; +4% needs about 2,000; +10% about 320. The shipped card plays 90 legs a
month, so it can never prove anything. A Pinnacle-gap rule qualifies about 30 band legs a
day, so 2,000 legs is roughly 65 forward days.

## Conclusion

1. A strategy built from our own data (prices, results, stats) will not become profitable
   with more data. The failure rate is constant because it is the price, and the price is
   the sufficient statistic for everything we hold. Scrap that goal as a profit source;
   keep the honest labelling.
2. An assured daily 2x is arithmetically unavailable at bookmaker prices.
3. The one lever with evidence is the sharp-reference gap, already built as the
   `anchored_picks` shadow (PR #21, not deployed). It needs 30 to 65 forward days of
   T-3h/T-1h capture to be proven or refuted, and even proven it is a +5% to +10% expected
   return over volume with losing weeks, not a daily guarantee.

Reproduce: `node tmp/analysis/f-verdict/verdict.mjs` (about 70 s).

## Addendum (same day): complete-data games and known-behaviour rules

Owner asked whether trimming to games with usable complete data and replacing the learned
calibration with logical rules changes the picture. Script and output:
`tmp/analysis/g-logic/`. Records already excluded from the extraction (and therefore from
every number above): odds rows updated at or after kickoff, listings with reversed sides,
simulated competitions, and fixtures that never reached FT/AET/PEN (postponed, cancelled,
abandoned).

Tiers, hindsight-free from the season record, the prior season, head-to-head and the
match-statistics feed:

| tier | games | share | band legs | hit | devig | ROI |
|---|---|---|---|---|---|---|
| all | 28,843 | 100% | 234,818 | 51.5% | 51.4% | -7.8% |
| thin (a side under 5 season games) | 13,486 | 47% | 109,350 | 51.5% | 51.4% | -7.6% |
| T1 both sides >= 10 season games | 9,650 | 34% | 79,347 | 51.5% | 51.4% | -7.9% |
| T2 T1 + prior season >= 10 + H2H >= 3 | 4,299 | 15% | 36,481 | 51.7% | 51.6% | -7.5% |
| T3 T2 + both sides >= 3 stat games | 1,045 | 4% | 9,477 | 52.0% | 51.9% | -6.9% |

The price is calibrated to within 0.1 point in every tier. Complete data does not make
the bookmaker less accurate; it makes the sample smaller.

Known-behaviour vectors (Poisson from season goals with the Dixon-Coles low-score
correction at the literature value, no parameter fitted) are worse than the price in every
tier and every family. 1X2 log loss on T2: price 0.5817, vector 0.6020; O/U 2.5: 0.6647 vs
0.6859; BTTS: 0.6778 vs 0.6899. A 50/50 blend with the price is also worse than the price
alone. Value bets where the vector calls the price generous (vector p x price >= 1.00,
1.05, 1.10) lose 7% to 16% in both windows and lose more on complete data, not less.

Hand-written rules with thresholds fixed in advance (clear strength gap, table gap, goal
tempo, H2H dominance, fade a hot streak, two weak attacks, three-rule agreement,
favourite-longshot) on T1 and T2 games: none is positive in both windows at a sample above
60 legs. The favourite-longshot bias is real (+0.4 to +0.9 points of lift at 1.16 average
odds) and the margin eats it (-4% ROI).

Where the vector disagrees with the price most (T2, 1X2 and O/U 2.5, 19,300 legs in
deciles): in the top decile the vector claims 57.3%, the price 41.2%, and the outcomes land
at 41.3%; in the bottom decile the vector claims 28.4%, the price 44.4%, outcomes 44.9%.
The price is right in every decile and the vector's disagreement is noise around it.

Conclusion: neither restriction nor reasoning improves profitability. The information in
the season record, the prior season, head-to-head and shot statistics is already in the
price, and it is most completely in the price exactly where the data is richest.

## Decision and start (same day, evening)

Owner chose the forward test. The shadow was already live on the host from the morning
backend deploy (files byte-identical to main, migration applied at the 11:41Z boot, knob on
by default); the first today..+2 page sweep was run by hand. Day 1 of the test is
2026-10-18. Pool size on day 1 is about 10 legs, so the 400-leg bar lands near day 40 rather
than day 30. Report: `node scripts/report-anchored.js` on the host.
