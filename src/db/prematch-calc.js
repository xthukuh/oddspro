// Pure pre-match snapshot calculations shared by the snapshot writer
// (src/prematch.js) and the read-layer live fallback (src/db/records.js).
// Zero imports on purpose (like odds-diff.js) so tests run without .env/DB.
//
// Division of labor: callers filter fixtures to RESULT_STATUSES in SQL;
// these helpers enforce the row-level rules — non-null FT scores and
// kickoff strictly before the analyzed fixture's kickoff.

// Summarize finished head-to-head meetings from the row's home-team
// perspective ("2W-1D-0L"), meetings strictly before this fixture's kickoff.
export function h2hSummary(h2h, r) {
    let w = 0, d = 0, l = 0;
    for (const f of h2h) {
        const home = f.home_team_id === r.home_team_id && f.away_team_id === r.away_team_id;
        const away = f.home_team_id === r.away_team_id && f.away_team_id === r.home_team_id;
        if (!(home || away) || f.ft_home == null || f.ft_away == null) continue;
        if (new Date(f.kickoff).getTime() >= new Date(r.kickoff).getTime()) continue;
        const [gf, ga] = home ? [f.ft_home, f.ft_away] : [f.ft_away, f.ft_home];
        if (gf > ga) w++;
        else if (gf < ga) l++;
        else d++;
    }
    return w + d + l ? `${w}W-${d}D-${l}L` : null;
}

// Qualifying history rows for a fixture kicking off at `cutoff`:
// scored and strictly earlier, newest first.
function _qualifying(rows, cutoff) {
    return rows
        .filter(f => f.ft_home != null && f.ft_away != null
            && new Date(f.kickoff).getTime() < cutoff)
        .sort((a, b) => new Date(b.kickoff).getTime() - new Date(a.kickoff).getTime());
}

// Goals for/against `team_id` summed over `rows` regardless of venue.
function _goals(rows, team_id) {
    let gf = 0, ga = 0;
    for (const f of rows) {
        const home = f.home_team_id === team_id;
        gf += home ? f.ft_home : f.ft_away;
        ga += home ? f.ft_away : f.ft_home;
    }
    return { gf, ga };
}

const _isPair = (f, a, b) =>
    (f.home_team_id === a && f.away_team_id === b) || (f.home_team_id === b && f.away_team_id === a);

// Compute the full pre-match snapshot field set for one fixture.
//   fixture: { home_team_id, away_team_id, kickoff }
//   fixturesByTeam: Map(team_id -> finished fixture rows involving that team)
//   homeStanding/awayStanding: { rank, form } | undefined
//   teamWindow/h2hWindow: rolling window sizes
export function computePrematch({ fixture, fixturesByTeam, homeStanding, awayStanding, teamWindow, h2hWindow }) {
    const { home_team_id, away_team_id } = fixture;
    const cutoff = new Date(fixture.kickoff).getTime();
    const homeRows = _qualifying(fixturesByTeam.get(home_team_id) ?? [], cutoff);
    const awayRows = _qualifying(fixturesByTeam.get(away_team_id) ?? [], cutoff);

    // Pair meetings (same set from either side's history)
    const meetings = homeRows.filter(f => _isPair(f, home_team_id, away_team_id));
    const windowed = meetings.slice(0, h2hWindow);
    const h2hGoals = _goals(windowed, home_team_id);

    // Per side: recent games against everyone but this opponent
    const _others = (rows, team_id) => {
        const recent = rows
            .filter(f => !_isPair(f, home_team_id, away_team_id))
            .slice(0, teamWindow);
        const { gf, ga } = _goals(recent, team_id);
        const n = recent.length;
        return { n, gf: n ? gf : null, ga: n ? ga : null };
    };
    const home = _others(homeRows, home_team_id);
    const away = _others(awayRows, away_team_id);

    return {
        home_rank: homeStanding?.rank ?? null,
        home_form: homeStanding?.form ?? null,
        away_rank: awayStanding?.rank ?? null,
        away_form: awayStanding?.form ?? null,
        h2h: h2hSummary(meetings, fixture),
        h2h_count: meetings.length,
        h2h_n: windowed.length,
        h2h_home_goals: windowed.length ? h2hGoals.gf : null,
        h2h_away_goals: windowed.length ? h2hGoals.ga : null,
        home_oth_n: home.n, home_oth_gf: home.gf, home_oth_ga: home.ga,
        away_oth_n: away.n, away_oth_gf: away.gf, away_oth_ga: away.ga,
    };
}

// Compact display string for a goals window: "gf/ga (avg total per game)".
export function formatGoals(gf, ga, n) {
    if (!n) return null;
    return `${gf}/${ga} (${((gf + ga) / n).toFixed(1)})`;
}
