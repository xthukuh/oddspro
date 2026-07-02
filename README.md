# ODDS PRO

Football bookmaker odds and stats.

- Combine fixtures from different data providers (bookmakers) using API Football fixtures as the base canonical record for related match correlation (matching is done via fixture metadata such as `start_time`, competition/league and name similarity - matched references cached for future correlations getting accurate as data grows). Only correlated records are considered when visualizing (date's) records. Notice betika records have missing identifier attributes (`home_team_id, away_team_id, region_id, region_name, category_id, competition_id`). Betika can therefore be correlated last so as to use a combination of base (API Football) and betpawa records for increased accuracy default to base identifiers where correlated. Similar record name-attribute field values can be cached and queried during correlation matching (fuzzy-match acceptance on high confidence percentage).

- Visualize available market odds alongside game statistics for informed beting tips. Display columns (temp-csv: `api_id(correlated canonical match), start_time, fixture (home_team_name + ' - ' + away_team_name), provider, match_url, score(home_score_fulltime + '-' + away_score_fulltime), goals(home_score_fulltime + away_score_fulltime), [multi_select_configured_market_columns (default): 1, X ,2, 1X, X2, 12, U 1.5, O 1.5, U 2.5, O 2.5, U 3.5, O 3.5, U 4.5, O 4.5],[STATS]`).

- Visualization is presented in dynamically queried paginated datatable with multi-sort columns, advanced query builder and filters. Settings and filters are configured in a seperate view/modal dialog. The `multi_select_configured_market_columns` is a dynamically toggled list of columns that can be configured in the visualization settings (multi-select dropdown control); with the default colums already pre-selected allowing user to add or remove odds markets shown. The `STATS` is a dynamically toggled list of columns that can be configured as well. Since all records lookup to a matching canonical base (API-Football) record, we can combine data fetched from the API-Football API service provider such as pre-match fixture stats, H2H, etc. as an additional advantege.

## Providers

- **API-Football** - root data provider via REST API *[v3.9.3](https://www.api-football.com/documentation-v3)* service. Credentials can be found in the `.env` file.

- **[BetPawa](https://betpawa.co.ke)** - Bookmaker 1, odds market data provider via undocumented public API data scraping *(see `./src/betpawa.js`)*.
- **[Betika](https://betika.com)** - Bookmaker 2, odds market data provider via undocumented public API data scraping *(see `./src/betika.js`)*.

## Commands

```sh
# npm run start -- [betpawa|betika] [YYYY-MM-DD]
npm run start -- betpawa 2026-07-03
npm run start -- betika 2026-07-03
```
