import { z } from 'zod';

// One API-Football /standings table row. Pure (zod-only, no config/db) so the
// parse + row-shaping contract is offline-testable, mirroring
// src/apisports-events.js.
//
// Schemas stay tolerant per the project convention ("live data has taught
// this"): the feed has been observed returning `points: null` (playoff/bracket
// slots carrying a real team id but no accumulated points), which previously
// threw at the zod boundary and aborted the whole standings sweep mid-run.
// Identity of a standings row = team + rank (the signals prematch/records
// actually read); accumulator stats are tolerated null and stored as 0, the
// same neutral the DB columns default to.
export const StandingRow = z.object({
    rank: z.number(),
    team: z.object({ id: z.number(), name: z.string(), logo: z.string().nullable().optional() }),
    points: z.number().nullable().optional(),
    goalsDiff: z.number().nullable().optional(),
    group: z.string().nullable().optional(),
    form: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    all: z.object({
        played: z.number().nullable().optional(),
        win: z.number().nullable().optional(),
        draw: z.number().nullable().optional(),
        lose: z.number().nullable().optional(),
        goals: z.object({
            for: z.number().nullable().optional(),
            against: z.number().nullable().optional(),
        }).nullable().optional(),
    }).nullable().optional(),
});

// Validate + shape one league's raw /standings groups into standings table rows.
// - Teamless placeholder rows (TBD bracket slots) are skipped: no FK target.
// - A row zod cannot parse is skipped and reported in `skipped`, never thrown -
//   one bad row must not abort the sweep (the apisports-events lesson).
// - Keyed by (team_id|group_name) so an in-response duplicate - some leagues,
//   e.g. MLS Next Pro, emit a team twice under an identically-labelled group -
//   collapses to one row instead of tripping the unique constraint.
export function buildStandingRows(groups, { league_id, season }) {
    const byKey = new Map(), teamsById = new Map(), skipped = [];
    for (const group of groups) {
        for (const raw of group) {
            if (!raw?.team?.id) continue;
            let r;
            try {
                r = StandingRow.parse(raw);
            } catch (err) {
                skipped.push({ raw, error: err });
                continue;
            }
            teamsById.set(r.team.id, { id: r.team.id, name: r.team.name, logo: r.team.logo ?? null });
            const group_name = r.group ?? '';
            byKey.set(`${r.team.id}|${group_name}`, {
                league_id,
                season,
                team_id: r.team.id,
                group_name,
                rank: r.rank,
                points: r.points ?? 0,
                goals_diff: r.goalsDiff ?? 0,
                form: r.form ?? null,
                description: r.description ?? null,
                played: r.all?.played ?? 0,
                win: r.all?.win ?? 0,
                draw: r.all?.draw ?? 0,
                lose: r.all?.lose ?? 0,
                goals_for: r.all?.goals?.for ?? 0,
                goals_against: r.all?.goals?.against ?? 0,
                metadata: JSON.stringify(raw),
            });
        }
    }
    return { rows: [...byKey.values()], teams: [...teamsById.values()], skipped };
}
