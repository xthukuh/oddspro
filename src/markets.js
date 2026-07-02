// Canonical odds market columns (Phase 6 visualization).
// Both providers expose the same markets under different type/name spellings;
// this registry is the single source of truth for the JS pivot (`marketKey`)
// and the SQL sort/filter conditions (`whereMarket`) so they can never drift.
//
// Verified live spellings (odds_markets survey 2026-07-02):
//   betpawa: "1X2 | Full Time" 1/X/2 · "Double Chance | Full Time" 1X/X2/12
//            · "Over/Under | Full Time" Over/Under + handicap
//   betika:  "1X2" 1/X/2 · "DOUBLE CHANCE" 1/X,X/2,1/2
//            · "TOTAL" OVER n.5/UNDER n.5 + handicap
// NOTE: match on type_name, never type_id - betika reuses type_id 19 across
// different team-total markets ("Z.PSV TOTAL" etc.).

const X12_TYPE_NAMES = ['1X2 | Full Time', '1X2'];                    // betpawa, betika
const DC_TYPE_NAMES = ['Double Chance | Full Time', 'DOUBLE CHANCE'];
const OU_TYPE_NAMES = ['Over/Under | Full Time', 'TOTAL'];

// Provider double-chance outcome spelling -> canonical column key
const DC_NAME_MAP = { '1X': '1X', 'X2': 'X2', '12': '12', '1/X': '1X', 'X/2': 'X2', '1/2': '12' };

// Full-time total-goals lines seen live; README defaults are 1.5-4.5
const OU_LINES = [0.5, 1.5, 2.5, 3.5, 4.5, 5.5, 6.5];
const DEFAULT_OU_LINES = new Set([1.5, 2.5, 3.5, 4.5]);

// Ordered canonical market column registry: 1, X, 2, 1X, X2, 12, U/O per line.
export const MARKET_COLUMNS = [
    ...['1', 'X', '2', '1X', 'X2', '12'].map(key => ({ key, label: key, default: true })),
    ...OU_LINES.flatMap(line => ['U', 'O'].map(side => ({
        key: `${side} ${line}`,
        label: `${side} ${line}`,
        default: DEFAULT_OU_LINES.has(line),
    }))),
];

const MARKET_KEYS = new Set(MARKET_COLUMNS.map(c => c.key));

// Whether `key` names a canonical market column
export function isMarketKey(key) {
    return MARKET_KEYS.has(key);
}

// Map an odds_markets row ({type_name, name, handicap}) to its canonical
// column key, or null when the row is not one of the canonical markets.
export function marketKey(row) {
    const type = row.type_name, name = String(row.name ?? '');
    if (X12_TYPE_NAMES.includes(type)) {
        return ['1', 'X', '2'].includes(name) ? name : null;
    }
    if (DC_TYPE_NAMES.includes(type)) {
        return DC_NAME_MAP[name] ?? null;
    }
    if (OU_TYPE_NAMES.includes(type)) {
        const line = Number(row.handicap);
        if (!OU_LINES.includes(line)) return null;
        const side = /^over/i.test(name) ? 'O' : /^under/i.test(name) ? 'U' : null;
        return side ? `${side} ${line}` : null;
    }
    return null;
}

// Apply the odds_markets WHERE conditions matching one canonical column key
// (used to build LEFT JOIN subqueries for SQL-level sort/filter on odds).
export function whereMarket(qb, key) {
    if (['1', 'X', '2'].includes(key)) {
        return qb.whereIn('type_name', X12_TYPE_NAMES).where('name', key);
    }
    const ou = /^([OU]) (\d\.5)$/.exec(key);
    if (ou) {
        return qb.whereIn('type_name', OU_TYPE_NAMES)
            .where('handicap', Number(ou[2]))
            .whereRaw('LOWER(name) LIKE ?', [(ou[1] === 'O' ? 'over' : 'under') + '%']);
    }
    const names = Object.entries(DC_NAME_MAP).filter(([, k]) => k === key).map(([n]) => n);
    if (!names.length) throw new TypeError(`Unknown market column key: ${key}`);
    return qb.whereIn('type_name', DC_TYPE_NAMES).whereIn('name', names);
}
