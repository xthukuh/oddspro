// Betting-lingo glossary shown in the Help dialog (HelpModal.jsx). Pure data,
// zero imports - offline-tested by tests/glossary.test.js, which asserts every
// entry carrying a market `key` uses the exact tipMarketLabel() wording so the
// glossary can never drift from the labels the table and popovers show.
// Copy rule: plain "-" only, never em/en dashes.
export const GLOSSARY = [
    {
        id: 'markets',
        title: 'Betting markets & codes',
        terms: [
            { term: '1X2', def: 'Match result market. 1 = home win, X = draw, 2 = away win. Settled on the full-time score; extra time and penalties do not count.' },
            { term: '1X', key: '1X', name: 'Home or draw', def: 'Double chance: wins if the home team wins or the match is drawn. Covers two of the three outcomes, so the odds are lower than a straight 1 or X.' },
            { term: 'X2', key: 'X2', name: 'Draw or away', def: 'Double chance: wins if the match is drawn or the away team wins.' },
            { term: '12', key: '12', name: 'Home or away', def: 'Double chance: wins if either team wins; loses only on a draw.' },
            { term: 'O / U', def: "Over/Under: a bet on the match's total goals landing above (O) or below (U) a set line. O 2.5 wins with 3 or more goals; U 2.5 wins with 2 or fewer. Half lines like 2.5 can never be tied, so the bet always settles win or lose." },
            { term: 'GG', key: 'GG', name: 'Both teams to score: Yes', def: 'Also called BTTS. Wins if both teams score at least one goal each.' },
            { term: 'NG', key: 'NG', name: 'Both teams to score: No', def: 'Wins if at least one team fails to score.' },
            { term: 'DNB1', key: 'DNB1', name: 'Home (draw no bet)', def: 'Draw no bet on the home side: wins if the home team wins; your stake is returned (void) if the match is drawn.' },
            { term: 'DNB2', key: 'DNB2', name: 'Away (draw no bet)', def: 'Draw no bet on the away side: wins if the away team wins; stake returned on a draw.' },
            { term: 'TT', key: 'TT:H:O 1.5', name: 'Home team over 1.5 goals', def: "Team total: an over/under on one team's goals only. TT:H is the home side, TT:A the away side; the example named here, TT:H:O 1.5, wins if the home team scores 2 or more." },
            { term: 'ODD', key: 'ODD', name: 'Odd total goals', def: 'Wins if the match total is an odd number (1, 3, 5, ...).' },
            { term: 'EVEN', key: 'EVEN', name: 'Even total goals', def: 'Wins if the match total is an even number (2, 4, ...). A 0-0 draw counts as even.' },
        ],
    },
    {
        id: 'pricing',
        title: 'Odds & pricing',
        terms: [
            { term: 'Odds (decimal)', def: 'The payout multiplier. A 1.60 price returns 1.60 per 1 staked (0.60 profit). Higher odds mean the bookmaker rates the outcome less likely.' },
            { term: 'Implied probability', def: 'The chance the odds suggest: 1 divided by the odds. A 1.60 price implies about 62.5%.' },
            { term: 'Overround (vig / margin)', def: "The bookmaker's built-in edge: the implied probabilities of a full market add up to more than 100% (say 105%), and that extra is the margin you pay to bet." },
            { term: 'Fair (devigged) odds', def: 'What the price would be with the bookmaker margin stripped out. Odds Pro removes the overround before comparing probabilities.' },
            { term: 'Price drift', def: 'A price moving over time as the bookmaker reacts to news and money. Odds refresh through the day, so a price can differ from when a tip was made.' },
            { term: 'Stale odds', def: 'A price the bookmaker has withdrawn. Shown greyed with the last-seen value, so you can still read it but may no longer be able to bet it.' },
        ],
    },
    {
        id: 'performance',
        title: 'Performance & stats',
        terms: [
            { term: 'Hit rate', def: 'The share of settled picks that won. A 70% hit rate means 7 of 10 picks won.' },
            { term: 'Break-even rate', def: 'The hit rate needed to avoid losing money at a given price: 1 divided by the odds. At 1.60 you must win about 62.5% of the time just to break even.' },
            { term: 'Flat stake', def: 'Betting the same amount (1 unit) on every pick. The standard honest way to measure performance.' },
            { term: 'ROI', def: 'Return on investment: profit divided by total staked. A -3% ROI means 100 units staked came back as 97.' },
            { term: 'EV', def: 'Expected value: the average profit or loss a bet would produce if repeated many times. Positive-EV bets earn long-term; most bets are negative-EV because of the bookmaker margin.' },
            { term: 'H2H', def: 'Head to head: the past meetings between the same two teams.' },
            { term: 'Form', def: 'Recent results as letters: W win, D draw, L loss (e.g. LWWWD). The number shown before it in the table is form points from those games.' },
            { term: 'Rolling window (last N)', def: "Stats computed over each team's most recent games rather than the whole season, so they track current form." },
        ],
    },
    {
        id: 'app',
        title: 'Odds Pro terms',
        terms: [
            { term: 'Tip', def: "The app's best-supported pick for a fixture across all markets, blending bookmaker odds, recent form and expert data." },
            { term: 'Confidence', def: 'How strongly the evidence backs the tip, shown as a percentage. It measures the chance of winning, not profitability.' },
            { term: 'Hot pick 🔥', def: "An Over 2.5 goals candidate that passed every one of the app's strict checks. Rare by design." },
            { term: 'Safe pick 🛡', def: 'A tip that also clears the stricter Safety Net gates (strong agreement, modest price, enough evidence). Built for multi-bet slips that survive.' },
            { term: 'Sure bets ⭐', def: "The day's top picks ranked by estimated chance of winning. A survival claim, never a profit promise. Signed-in feature." },
            { term: 'Magic sort', def: 'Reorders the table by a strategy ranked on how it would have performed over past settled days, best first.' },
            { term: 'Slip / legs', def: 'A multi-bet: several picks (legs) combined into one bet. The odds multiply and every leg must win, so each added leg raises the payout but lowers the chance the slip survives.' },
            { term: 'Void', def: 'A bet returned with no win or loss (stake back). Example: draw no bet when the match ends in a draw.' },
            { term: 'One of each', def: 'A view option showing a single row per match from your highest-priority bookmaker, instead of one row per bookmaker.' },
        ],
    },
];
