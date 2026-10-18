// The lean /api/records body (2026-10-18 phone pass): one loader and one memo
// key shared by the route (src/server.js) and the warm keeper (src/warm.js),
// so a warmed slot is byte-for-byte the slot a visitor's request hits.
//
// A lean body is queryRecords' lean rows plus `ranked` - the default Tip
// order and the Safe / Top picks memberships computed here once per memo
// slot (src/db/ranked-rules.js), so the browser renders them as delivered.
// `ranked` is null while today's magic-sort summary is still computing: the
// table never waits on the calibration, and the browser falls back to its
// own scoring once /api/magic-sort answers.
import { queryRecords } from './db/records.js';
import { magicSortReady } from './magic.js';
import { queryCacheKey } from './db/cache-rules.js';
import { rankedView, rankedSignature } from './db/ranked-rules.js';

// Which gated memberships a caller may see, from its featureMap() (null =
// the legacy full path: machine bearer or AUTH_ENABLED=0).
export function rankedAllow(features) {
    return {
        allowSafe: !features || features.safe_picks === true,
        allowSure: !features || features.sure_bets === true,
    };
}

// The memo key. `params` are the query params that change the rows (the
// route's existing list), `markets` the canonical market selection. The
// ranked signature rides the key so a calibration that lands, a new day or
// an admin SAFE_* edit mints a new slot instead of serving a stale ranking.
export function leanRecordsKey({ day, tier, markets, allow, params = {} }) {
    return queryCacheKey('/api/records', {
        ...params, date: day, tier, markets, lean: 1,
        ranked: rankedSignature(magicSortReady(), allow),
        ranked_gates: `${allow.allowSafe ? 1 : 0}${allow.allowSure ? 1 : 0}`,
    });
}

export async function leanRecordsBody(queryArgs, allow) {
    const body = await queryRecords({ ...queryArgs, lean: true });
    const magic = magicSortReady();
    return { ...body, ranked: magic ? rankedView(body.data, magic, allow) : null };
}
