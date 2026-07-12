import { z } from 'zod';

// One API-Football /fixtures/events item. Pure (zod-only, no config/db) so the
// parse + row-shaping contract is offline-testable, mirroring src/ai-parse.js.
//
// Schemas stay tolerant per the project convention ("live data has taught
// this"): the feed has been observed returning `type: null` on a stray event,
// which previously threw at the zod boundary and aborted the whole deep-stats
// sweep. `type` is nullable here; typeless events are dropped by buildEventRows
// (fixture_events.type is NOT NULL - a type-less event carries no meaning).
export const EventItem = z.object({
    time: z.object({ elapsed: z.number(), extra: z.number().nullable().optional() }),
    team: z.object({ id: z.number().nullable().optional() }).partial().nullable().optional(),
    player: z.object({ id: z.number().nullable().optional(), name: z.string().nullable().optional() }).partial().nullable().optional(),
    assist: z.object({ id: z.number().nullable().optional(), name: z.string().nullable().optional() }).partial().nullable().optional(),
    type: z.string().nullable().optional(),
    detail: z.string().nullable().optional(),
    comments: z.string().nullable().optional(),
});

// Validate + shape a fixture's raw /fixtures/events response into fixture_events
// rows. Events without a type are skipped (fixture_events.type is NOT NULL and
// the type IS the event's meaning - mirrors the lineups' required-name skip).
export function buildEventRows(rawItems, fixture_id) {
    const rows = [];
    for (const raw of rawItems) {
        const item = EventItem.parse(raw);
        if (!item.type) continue;
        rows.push({
            fixture_id,
            team_id: item.team?.id ?? null,
            elapsed: item.time.elapsed,
            extra: item.time.extra ?? null,
            type: item.type,
            detail: item.detail ?? null,
            comments: item.comments ?? null,
            player_id: item.player?.id ?? null,
            player_name: item.player?.name ?? null,
            assist_id: item.assist?.id ?? null,
            assist_name: item.assist?.name ?? null,
        });
    }
    return rows;
}
