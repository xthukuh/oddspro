# Help dialog: collapsible sections + betting glossary — design

Date: 2026-07-17
Status: approved design, pending user spec review
Scope: web only (no server, no migration, no API change)

## Goal

The Help dialog explains the app but not the lingo. Add a glossary of sports-betting
abbreviations and terms, and restructure the dialog into collapsible sections so the
new content doesn't turn it into a wall of text.

## Decisions (user-approved)

- Glossary covers all four categories: market abbreviations, odds & pricing concepts,
  performance & stats terms, app-specific terms.
- On open: the About/How-to-use section starts expanded; everything else collapsed.
  Independent toggles (not an accordion). No open-state persistence.
- Approach A: pure-data glossary module + a reusable collapse component.

## Files

### `web/src/components/CollapseSection.jsx` (new)

Reusable collapsible section. Props: `{ title, defaultOpen = false, children }`.

- Header is a full-width button (≥44px tap target), `aria-expanded`, with the
  ▸ chevron that rotates 90° when open — the exact idiom `BetslipPlayground.jsx`
  already uses inline (that file is NOT migrated; out of scope).
- Body is conditionally rendered (not CSS-hidden) — closed sections mount nothing,
  which is what keeps the YouTube iframe from loading until its section is opened.
- Hairline `border-separator` between sections; header text `text-sm font-semibold`;
  local `useState` only.

### `web/src/glossary.js` (new)

Zero-import pure data module (offline-testable like `filterValues.js`):

```js
export const GLOSSARY = [
  { id, title, terms: [{ term, def, key?, name? }] },  // 4 categories
];
```

When `key` is present, `name` MUST equal `tipMarketLabel(key)` from
`src/db/magic-rules.js` — asserted by the new test so the glossary can never
drift from the labels the table/popover show. Entries without `key` are concepts.

### `web/src/components/HelpModal.jsx` (restructure)

Section stack inside the existing `Sheet`:

1. **About & how to use** — `defaultOpen` — current intro paragraph + 5 feature bullets, unchanged copy.
2. **Betting markets & codes** — collapsed.
3. **Odds & pricing** — collapsed.
4. **Performance & stats** — collapsed.
5. **Odds Pro terms** — collapsed.
6. **Demo video** — collapsed — the existing embed/placeholder block moves here verbatim.

The maintainer credit line stays at the bottom, outside any section. Header row
(title, pin, close) unchanged. Glossary sections render terms as compact rows:
bold `term`, then `name` (when present), then `def` in `text-sm text-label-2`.

## Content rules

- Definitions are public industry knowledge plus what a UI element shows. NO
  methodology internals (blend weights, gate thresholds, strategy details stay
  behind the details gate). The glossary is identical for guests and signed-in users.
- No em dashes anywhere in the copy (Phase J rule) — plain "-" only; test-asserted.
- Kenyan-bookmaker phrasing welcome; the user reviews the exact wording below.

## Glossary content (full draft)

### Betting markets & codes

| Term | Name (tipMarketLabel) | Definition |
|---|---|---|
| 1X2 | - | Match result market. 1 = home win, X = draw, 2 = away win. Settled on the full-time score; extra time and penalties do not count. |
| 1X | Home or draw | Double chance: wins if the home team wins or the match is drawn. Covers two of the three outcomes, so the odds are lower than a straight 1 or X. |
| X2 | Draw or away | Double chance: wins if the match is drawn or the away team wins. |
| 12 | Home or away | Double chance: wins if either team wins; loses only on a draw. |
| O / U | - | Over/Under: a bet on the match's total goals landing above (O) or below (U) a set line. O 2.5 wins with 3 or more goals; U 2.5 wins with 2 or fewer. Half lines like 2.5 can never be tied, so the bet always settles win or lose. |
| GG | Both teams to score: Yes | Also called BTTS. Wins if both teams score at least one goal each. |
| NG | Both teams to score: No | Wins if at least one team fails to score. |
| DNB1 | Home (draw no bet) | Draw no bet on the home side: wins if the home team wins; your stake is returned (void) if the match is drawn. |
| DNB2 | Away (draw no bet) | Draw no bet on the away side: wins if the away team wins; stake returned on a draw. |
| TT (key example `TT:H:O 1.5`) | Home team over 1.5 goals | Team total: an over/under on one team's goals only. TT:H is the home side, TT:A the away side; TT:H:O 1.5 wins if the home team scores 2 or more. |
| ODD | Odd total goals | Wins if the match total is an odd number (1, 3, 5, ...). |
| EVEN | Even total goals | Wins if the match total is an even number (2, 4, ...). A 0-0 draw counts as even. |

### Odds & pricing

| Term | Definition |
|---|---|
| Odds (decimal) | The payout multiplier. A 1.60 price returns 1.60 per 1 staked (0.60 profit). Higher odds mean the bookmaker rates the outcome less likely. |
| Implied probability | The chance the odds suggest: 1 divided by the odds. A 1.60 price implies about 62.5%. |
| Overround (vig / margin) | The bookmaker's built-in edge: the implied probabilities of a full market add up to more than 100% (say 105%), and that extra is the margin you pay to bet. |
| Fair (devigged) odds | What the price would be with the bookmaker margin stripped out. Odds Pro removes the overround before comparing probabilities. |
| Price drift | A price moving over time as the bookmaker reacts to news and money. Odds refresh through the day, so a price can differ from when a tip was made. |
| Stale odds | A price the bookmaker has withdrawn. Shown greyed with the last-seen value, so you can still read it but may no longer be able to bet it. |

### Performance & stats

| Term | Definition |
|---|---|
| Hit rate | The share of settled picks that won. A 70% hit rate means 7 of 10 picks won. |
| Break-even rate | The hit rate needed to avoid losing money at a given price: 1 divided by the odds. At 1.60 you must win about 62.5% of the time just to break even. |
| Flat stake | Betting the same amount (1 unit) on every pick. The standard honest way to measure performance. |
| ROI | Return on investment: profit divided by total staked. A -3% ROI means 100 units staked came back as 97. |
| EV | Expected value: the average profit or loss a bet would produce if repeated many times. Positive-EV bets earn long-term; most bets are negative-EV because of the bookmaker margin. |
| H2H | Head to head: the past meetings between the same two teams. |
| Form | Recent results as letters: W win, D draw, L loss (e.g. LWWWD). The number shown before it in the table is form points from those games. |
| Rolling window (last N) | Stats computed over each team's most recent games rather than the whole season, so they track current form. |

### Odds Pro terms

| Term | Definition |
|---|---|
| Tip | The app's best-supported pick for a fixture across all markets, blending bookmaker odds, recent form and expert data. |
| Confidence | How strongly the evidence backs the tip, shown as a percentage. It measures the chance of winning, not profitability. |
| Hot pick 🔥 | An Over 2.5 goals candidate that passed every one of the app's strict checks. Rare by design. |
| Safe pick 🛡 | A tip that also clears the stricter Safety Net gates (strong agreement, modest price, enough evidence). Built for multi-bet slips that survive. |
| Sure bets ⭐ | The day's top picks ranked by estimated chance of winning. A survival claim, never a profit promise. Signed-in feature. |
| Magic sort | Reorders the table by a strategy ranked on how it would have performed over past settled days, best first. |
| Slip / legs | A multi-bet: several picks (legs) combined into one bet. The odds multiply and every leg must win, so each added leg raises the payout but lowers the chance the slip survives. |
| Void | A bet returned with no win or loss (stake back). Example: draw no bet when the match ends in a draw. |
| One of each | A view option showing a single row per match from your highest-priority bookmaker, instead of one row per bookmaker. |

## Testing

New `tests/glossary.test.js` (node:test, offline, zero DB/network):

- Every entry carrying `key` has `name === tipMarketLabel(key)`.
- Every category has `id`, `title`, and at least one term; every `term`/`def` is a
  non-empty string; terms unique within a category.
- No em/en dash characters (U+2014, U+2013) in any `term`, `name` or `def`.

Browser verification (dev, :5173): Help opens with About expanded and the other five
sections collapsed; each toggles independently; the YouTube embed request only fires
after expanding Demo video; guest and signed-in views identical; zero console errors.

## Non-goals

- No open-state persistence, no glossary search, no term tooltips elsewhere in the app.
- No BetslipPlayground migration onto CollapseSection.
- No server/API change; `web/dist` rebuild remains a deploy-time step (the next
  deploy package already requires `npm run build:web` for the filters-sync feature).
