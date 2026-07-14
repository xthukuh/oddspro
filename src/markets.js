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

// --- Generic market taxonomy (M2 Task 1) -------------------------------------
// Parallel to the fixed MARKET_COLUMNS registry above: covers ALL stored markets
// for display/filter/sort. Does NOT feed predictions (that's M3). Keyed on
// type_name (never type_id). `columnizable`: 'column' = table-column eligible,
// 'grouped' = medium cardinality (detail view), 'filter-only' = huge/props.
//
// Betika emits a large DYNAMIC tail of type_names (team-embedded totals like
// "Z.PSV TOTAL", period prefixes "1ST HALF - TOTAL", interval markets
// "N MINUTES - ... FROM 1ST TO Nth", and combined markets "A & B"). An
// exact-type_name family table alone would explode the catalog, so
// `_normType` normalizes BEFORE any family lookup:
//   1. strips a Betika period/interval PREFIX ("1ST/2ND HALF - ", "N MINUTES - ")
//      and a BetPawa period SUFFIX (" | First Half" / " | Second Half" /
//      " | Full Time"), capturing a `period` tag (null for Full Time/no qualifier)
//   2. detects "A & B" / "A and B" combos (`combo` family) BEFORE team-total
//      detection, because some combos ("DOUBLE CHANCE & TOTAL", "1X2 & TOTAL")
//      themselves end in " TOTAL" and would otherwise be misread as a team total
//   3. detects team-embedded totals -- Betika "<TEAM> TOTAL" (prefix not a known
//      market keyword) and BetPawa's clean "Over/Under | {home}/{away} | ..."
//      equivalents -- as one `team_total` family, team identity dropped from
//      the key (kept in the label for display)
// Verified against the live inventory (tmp/market-inventory.txt, both providers,
// 18,606 lines) 2026-07-14: Betika has NO "DRAW NO BET" or "ODD/EVEN" type_name
// at all -- DNB and Odd/Even are BetPawa-only families here (do not invent a
// Betika spelling for either).
const _norm = s => String(s ?? '').trim();
const _slug = s => _norm(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

// Betika: "1ST HALF - <rest>" / "2ND HALF - <rest>"
const _PERIOD_PREFIX_HALF = /^(1ST|2ND) HALF - (.+)$/i;
// Betika: "<N> MINUTES - <rest>" (interval markets, e.g. "10 MINUTES - 1X2 FROM 1ST TO 10TH")
const _PERIOD_PREFIX_INTERVAL = /^(\d+) MINUTES - (.+)$/i;
// BetPawa: "<rest> | First Half" / "<rest> | Second Half" / "<rest> | Full Time"
const _PERIOD_SUFFIX_BETPAWA = /^(.+) \| (First Half|Second Half|Full Time)$/i;
const _PERIOD_LABEL = { '1H': 'First Half', '2H': 'Second Half' };

// Strip period/interval qualifiers from a raw type_name, returning the
// normalized base string (used for family lookup) plus a period tag
// ('1H' | '2H' | '<N>m' | null). Pure, exported for direct testing.
export function _normType(type_name) {
    let s = _norm(type_name);
    let period = null;
    let m = _PERIOD_PREFIX_HALF.exec(s);
    if (m) {
        period = /^1st$/i.test(m[1]) ? '1H' : '2H';
        s = m[2];
    } else if ((m = _PERIOD_PREFIX_INTERVAL.exec(s))) {
        period = `${m[1]}m`;
        s = m[2];
    }
    m = _PERIOD_SUFFIX_BETPAWA.exec(s);
    if (m) {
        s = m[1];
        const half = m[2].toLowerCase();
        if (half === 'first half') period = period || '1H';
        else if (half === 'second half') period = period || '2H';
        // 'full time' -> no override; period stays whatever the prefix set (or null)
    }
    return { base: s, period };
}

// Recognized market-keyword segments for combo detection (§ below) -- both
// sides of a genuine "A & B"/"A and B" combo are drawn from this small set;
// team names that happen to contain "&" (e.g. "Walton & Hersham") never match
// on their first segment, so they fall through to the team-total check instead.
const _COMBO_KEYWORDS = new Set([
    '1X2', 'DOUBLE CHANCE', 'TOTAL', 'TOTALS', 'BOTH TEAMS TO SCORE',
    'HALFTIME/FULLTIME', 'HALF TIME/FULL TIME', 'HT/FT', 'OVER/UNDER', 'HANDICAP',
]);

// True when `base` (already period-stripped) is a combined "A & B" market.
function _isCombo(base) {
    const parts = base.split(/\s+(?:&|and)\s+/i).map(_norm).filter(Boolean);
    return parts.length >= 2 && _COMBO_KEYWORDS.has(parts[0].toUpperCase());
}

// Detects a team-embedded total market on the period-stripped `base`:
//   - BetPawa's clean placeholder form: "Over/Under | {home}" / "... | {away}"
//   - Betika's team-name-embedded form: "<TEAM NAME> TOTAL" (prefix not itself
//     a recognized combo keyword -- guards against "DOUBLE CHANCE & TOTAL" etc.,
//     which _isCombo() must catch FIRST since it also ends in " TOTAL")
// Returns { side: 'home'|'away'|null, team: string|null } or null.
function _teamTotalMatch(base) {
    const ph = /\{(home|away)\}/i.exec(base);
    if (ph && /over\/?under|total/i.test(base)) return { side: ph[1].toLowerCase(), team: null };
    const m = /^(.+) TOTAL$/.exec(base);
    if (m && !_COMBO_KEYWORDS.has(_norm(m[1]).toUpperCase())) return { side: null, team: _norm(m[1]) };
    return null;
}

// Over/Under key from name+handicap alone (mirrors marketKey's OU branch, but
// without a type_name check -- family membership is already established by the
// caller via the normalized base, so this is reusable for period-tagged and
// team-total variants too).
function _resolveOU(row) {
    const line = Number(row.handicap);
    if (!OU_LINES.includes(line)) return null;
    const name = _norm(row.name);
    const side = /^over/i.test(name) ? 'O' : /^under/i.test(name) ? 'U' : null;
    return side ? `${side} ${line}` : null;
}

// Family table: fixed, small, exact-typeName-keyed markets (post period-strip
// bases). `team_total`/`combo` are dynamic/pattern-matched and handled directly
// in canonicalMarket() below, not as MARKET_FAMILIES entries (they don't have a
// bounded typeNames list).
export const MARKET_FAMILIES = [
    { group: 'result', columnizable: 'column',
      typeNames: ['1X2'],
      resolve: row => (['1', 'X', '2'].includes(_norm(row.name)) ? { key: _norm(row.name), label: _norm(row.name) } : null) },
    { group: 'double_chance', columnizable: 'column',
      typeNames: ['Double Chance', 'DOUBLE CHANCE'],
      resolve: row => { const k = DC_NAME_MAP[_norm(row.name)]; return k ? { key: k, label: k } : null; } },
    { group: 'over_under', columnizable: 'column',
      typeNames: ['Over/Under', 'TOTAL'],
      resolve: row => { const k = _resolveOU(row); return k ? { key: k, label: k } : null; } },
    { group: 'btts', columnizable: 'column',
      // BetPawa: "Both Teams To Score" (post-suffix-strip). Betika: the
      // full-time spelling carries "(GG/NG)"; the half-prefixed spelling
      // ("1ST HALF - BOTH TEAMS TO SCORE") drops it after prefix-strip --
      // both confirmed live, both listed.
      typeNames: ['Both Teams To Score', 'BOTH TEAMS TO SCORE (GG/NG)', 'BOTH TEAMS TO SCORE'],
      resolve: row => { const n = _norm(row.name); const y = /^(yes|gg)$/i.test(n); const no = /^(no|ng)$/i.test(n);
          return y ? { key: 'GG', label: 'BTTS Yes' } : no ? { key: 'NG', label: 'BTTS No' } : null; } },
    { group: 'dnb', columnizable: 'column',
      // BetPawa only -- confirmed no Betika "DRAW NO BET" type_name exists.
      typeNames: ['Draw No Bet'],
      resolve: row => { const n = _norm(row.name); return (n === '1' || n === '2')
          ? { key: `DNB${n}`, label: `DNB ${n}` } : null; } },
    { group: 'odd_even', columnizable: 'column',
      // BetPawa only -- confirmed no Betika "ODD/EVEN" type_name exists.
      typeNames: ['Odd/Even'],
      resolve: row => { const n = _norm(row.name); const o = /^odd/i.test(n); const e = /^even/i.test(n);
          return o ? { key: 'ODD', label: 'Odd' } : e ? { key: 'EVEN', label: 'Even' } : null; } },
    { group: 'ht_ft', columnizable: 'grouped',
      typeNames: ['Half Time/Full Time', 'HALFTIME/FULLTIME'],
      resolve: row => ({ key: `HTFT:${_slug(row.name)}`, label: `HT/FT ${_norm(row.name)}` }) },
    { group: 'correct_score', columnizable: 'filter-only',
      typeNames: ['Correct Score', 'CORRECT SCORE'],
      resolve: row => ({ key: `CS:${_slug(row.name)}`, label: `Correct Score ${_norm(row.name)}` }) },
];

const _FAMILY_BY_TYPE = new Map();
for (const fam of MARKET_FAMILIES) for (const tn of fam.typeNames) _FAMILY_BY_TYPE.set(tn, fam);

// Any provider odds_markets row -> a stable canonical market descriptor.
// Never returns null: an unrecognized market becomes a deterministic `raw:` key
// (filter-only) so it is visible/queryable and never silently dropped.
export function canonicalMarket(row) {
    const { base, period } = _normType(row.type_name);

    // "A & B" / "A and B" combos -- checked BEFORE team-total detection, since
    // some combos ("DOUBLE CHANCE & TOTAL", "1X2 & TOTAL") end in " TOTAL" too.
    if (_isCombo(base)) {
        return {
            key: `combo:${_slug(row.type_name)}:${_slug(row.name)}`,
            group: 'combo',
            label: `${_norm(row.type_name)} — ${_norm(row.name)}`,
            columnizable: 'grouped',
        };
    }

    // Team-embedded totals (Betika "<TEAM> TOTAL" / BetPawa "{home}"/"{away}").
    const tt = _teamTotalMatch(base);
    if (tt) {
        const ouKey = _resolveOU(row);
        if (ouKey) {
            const who = tt.team || (tt.side === 'home' ? 'Home' : tt.side === 'away' ? 'Away' : '');
            return {
                key: `TT:${ouKey}`,
                group: 'team_total',
                label: `${who ? who + ' ' : ''}${ouKey}`.trim(),
                columnizable: 'grouped',
            };
        }
    }

    // Fixed families, matched on the period-stripped base.
    const fam = _FAMILY_BY_TYPE.get(base);
    if (fam) {
        const r = fam.resolve(row);
        if (r) {
            const key = period ? `${r.key}:${period}` : r.key;
            const label = period ? `${r.label} (${_PERIOD_LABEL[period] || period})` : r.label;
            return { key, group: fam.group, label, columnizable: fam.columnizable };
        }
    }

    // Unknown market -> deterministic raw passthrough, never dropped.
    const hc = Number.isFinite(Number(row.handicap)) && row.handicap != null ? `:${Number(row.handicap)}` : '';
    return {
        key: `raw:${_slug(row.type_name)}:${_slug(row.name)}${hc}`,
        group: 'other',
        label: `${_norm(row.type_name)} — ${_norm(row.name)}${hc ? ` (${Number(row.handicap)})` : ''}`,
        columnizable: 'filter-only',
    };
}
