// The Pick's calibrator (2026-10-16): thin knex shell around the pure
// src/db/pick-rules.js. The sweep (hotpicks.js) scores every upcoming game
// with it; the Daily MultiBet ranks the stored picks it produced.
//
// One load per EAT day. The cells are cached in `meta` under PICK_CELLS_KEY
// as { day, cal: export() }, so a second sweep, a manual date refresh or a
// restarted instance on the same day rehydrates ~90 small cells instead of
// re-reading 90 days of odds (the window load is the expensive part:
// ~10k fixtures, chunked; see src/daily-slip.js _settledWindow).
import { db } from './db/connection.js';
import { getMeta, setMeta } from './meta.js';
import { loadSettledWindow } from './daily-slip.js';
import { makePickCalibrator } from './db/pick-rules.js';
import { tipOutcome } from './db/tip-rules.js';
import { debugLog } from './utils.js';

export const PICK_CELLS_KEY = 'pick_cells';
const PICK_WINDOW_DAYS = 90;   // same window the replay (scripts/replay-picks.js) measured

// Every pre-kickoff menu leg of every final fixture in the window strictly
// before `beforeDate` (EAT date string) teaches its cell.
export async function loadPickCalibrator(beforeDate, windowDays = PICK_WINDOW_DAYS) {
    const { fixtures, preMenus } = await loadSettledWindow(beforeDate, windowDays);
    const cal = makePickCalibrator();
    for (const f of fixtures) {
        for (const leg of preMenus?.get(f.id) ?? []) {
            let outcome = null;
            try { outcome = tipOutcome(leg.market, f.ft_home, f.ft_away); } catch { continue; }
            cal.observe({ ...leg, outcome });
        }
    }
    return cal;
}

export async function todaysPickCalibrator() {
    const [{ today }] = (await db.raw("SELECT DATE_FORMAT(CURDATE(), '%Y-%m-%d') as today"))[0];
    const memo = await getMeta(PICK_CELLS_KEY).catch(() => null);
    if (memo?.day === today && memo.cal?.cells) return makePickCalibrator(memo.cal);
    const t0 = Date.now();
    const cal = await loadPickCalibrator(today);
    await setMeta(PICK_CELLS_KEY, { day: today, cal: cal.export() });
    debugLog(`picks: calibrator for ${today} built in ${Date.now() - t0}ms`);
    return cal;
}
