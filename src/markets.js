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
            label: `${_norm(row.type_name)} - ${_norm(row.name)}`,
            columnizable: 'grouped',
        };
    }

    // Team-embedded totals (Betika "<TEAM> TOTAL" / BetPawa "{home}"/"{away}").
    // The home/away collapse is intentional (design-note "prefix dropped from key",
    // team identity kept only in the label; Task 3/4 owns any home/away split), but
    // the PERIOD must be threaded exactly like the fixed-family branch below, else a
    // First Half and a Full Time team-total of the same line collide on `TT:<line>`.
    const tt = _teamTotalMatch(base);
    if (tt) {
        const ouKey = _resolveOU(row);
        if (ouKey) {
            const who = tt.team || (tt.side === 'home' ? 'Home' : tt.side === 'away' ? 'Away' : '');
            const key = period ? `TT:${ouKey}:${period}` : `TT:${ouKey}`;
            const base_label = `${who ? who + ' ' : ''}${ouKey}`.trim();
            const label = period ? `${base_label} (${_PERIOD_LABEL[period] || period})` : base_label;
            return { key, group: 'team_total', label, columnizable: 'grouped' };
        }
    }

    // Fixed families, matched on the period-stripped base.
    const fam = _FAMILY_BY_TYPE.get(base);
    if (fam) {
        const r = fam.resolve(row);
        if (r) {
            const key = period ? `${r.key}:${period}` : r.key;
            const label = period ? `${r.label} (${_PERIOD_LABEL[period] || period})` : r.label;
            // NOTE: columnizable:'column' on a PERIOD-TAGGED variant (e.g. `O 2.5:1H`)
            // does NOT mean "promote as a MARKET_COLUMNS table column" -- it just marks
            // the family class. Task 3/4 decides which discovered keys become columns.
            return { key, group: fam.group, label, columnizable: fam.columnizable };
        }
    }

    // Unknown market -> deterministic raw passthrough, never dropped.
    const hc = Number.isFinite(Number(row.handicap)) && row.handicap != null ? `:${Number(row.handicap)}` : '';
    return {
        key: `raw:${_slug(row.type_name)}:${_slug(row.name)}${hc}`,
        group: 'other',
        label: `${_norm(row.type_name)} - ${_norm(row.name)}${hc ? ` (${Number(row.handicap)})` : ''}`,
        columnizable: 'filter-only',
    };
}

// --- marketIdentity: generic key -> WHERE builder (M2 Task 2) ---------------
// Generic replacement for whereMarket(): given ANY canonicalMarket() key
// (canonical, named simple family, or best-effort grouped/raw), applies the
// odds_markets WHERE selecting the matching row(s) and returns qb. The read
// layer (Task 4) uses this for SQL-level sort/filter on markets beyond the
// fixed MARKET_COLUMNS registry. Exactness varies by key shape:
//   - canonical period-null keys (1/X/2/1X/X2/12, U|O <line>) -> delegates to
//     the proven whereMarket() unchanged.
//   - named simple families, period-null (GG/NG/DNB1/DNB2/ODD/EVEN) -> exact
//     type_name + name predicate, against the REAL full-time raw spellings
//     (never the period-stripped `base` forms MARKET_FAMILIES keys on
//     internally -- see _SIMPLE_FT_TYPES below).
//   - everything else (period-tagged keys, TT:/combo:/HTFT:/CS:/raw:) ->
//     best-effort LIKE decode targeting type_name (never type_id -- betika
//     reuses ids across markets), filter-only, and never throws.

// Real FULL-TIME raw type_name spellings for the period-null named simple
// families. NOT the period-stripped `base` strings MARKET_FAMILIES.typeNames
// carries internally (e.g. the bare 'BOTH TEAMS TO SCORE' only ever occurs as
// a 1ST/2ND-HALF-prefix-stripped base -- it is never a literal full-time
// type_name; confirmed against tmp/market-inventory.txt, 18,606 lines, both
// providers). DNB and Odd/Even are confirmed BetPawa-only -- no Betika
// spelling exists for either, so none is invented here.
const _SIMPLE_FT_TYPES = {
    GG: ['Both Teams To Score | Full Time', 'BOTH TEAMS TO SCORE (GG/NG)'],
    NG: ['Both Teams To Score | Full Time', 'BOTH TEAMS TO SCORE (GG/NG)'],
    DNB1: ['Draw No Bet | Full Time'],
    DNB2: ['Draw No Bet | Full Time'],
    ODD: ['Odd/Even | Full Time'],
    EVEN: ['Odd/Even | Full Time'],
};

// LIKE-match token for a simple family's base type_name (period-tagged
// best-effort fallback only): period-tagged raw spellings prefix or suffix
// this exact substring (e.g. "1ST HALF - BOTH TEAMS TO SCORE" / "Both Teams
// To Score | First Half"), so a case-insensitive substring LIKE still finds it
// even though there is no fixed period-tagged type_name to match exactly.
const _SIMPLE_TYPE_LIKE_TOKEN = {
    GG: 'both teams to score', NG: 'both teams to score',
    DNB1: 'draw no bet', DNB2: 'draw no bet',
    ODD: 'odd/even', EVEN: 'odd/even',
};

// Outcome-name predicate shared by the period-null EXACT branch and the
// period-tagged best-effort branch (period never changes the outcome-name
// spelling, only the type_name gets prefixed/suffixed). Selects the SAME
// outcomes each family's resolve() accepts in canonicalMarket(), but as a
// prefix LIKE (e.g. 'yes%'/'gg%') rather than resolve()'s anchored
// /^(yes|gg)$/i -- looser by design, so a stray longer outcome-name variant is
// tolerated; DNB uses an exact name match, matching resolve()'s n==='1'/'2'.
function _applySimpleFamilyName(qb, key) {
    if (key === 'DNB1') return qb.where('name', '1');
    if (key === 'DNB2') return qb.where('name', '2');
    const likes = key === 'GG' ? ['yes%', 'gg%']
        : key === 'NG' ? ['no%', 'ng%']
        : key === 'ODD' ? ['odd%']
        : ['even%']; // EVEN
    return qb.where(b => {
        likes.forEach((p, i) => i === 0
            ? b.whereRaw('LOWER(name) LIKE ?', [p])
            : b.orWhereRaw('LOWER(name) LIKE ?', [p]));
    });
}

// Best-effort period-tagged fallback for a canonical (period-null) key: keeps
// the SAME outcome-name predicate whereMarket() would apply, but loosens the
// type_name predicate to a substring LIKE, since period-tagged spellings
// (Betika prefix / BetPawa suffix) have no single fixed type_name to match
// exactly the way the period-null registry does.
function _canonicalLike(qb, key) {
    if (['1', 'X', '2'].includes(key)) {
        return qb.whereRaw('LOWER(type_name) LIKE ?', ['%1x2%']).where('name', key);
    }
    const ou = /^([OU]) (\d\.5)$/.exec(key);
    if (ou) {
        return qb.where(b => b.whereRaw('LOWER(type_name) LIKE ?', ['%total%'])
                .orWhereRaw('LOWER(type_name) LIKE ?', ['%over/under%']))
            .where('handicap', Number(ou[2]))
            .whereRaw('LOWER(name) LIKE ?', [(ou[1] === 'O' ? 'over' : 'under') + '%']);
    }
    const names = Object.entries(DC_NAME_MAP).filter(([, k]) => k === key).map(([n]) => n);
    return qb.whereRaw('LOWER(type_name) LIKE ?', ['%double chance%']).whereIn('name', names);
}

// typeNames declared on a MARKET_FAMILIES entry, by group (DRY lookup so the
// HTFT:/CS: best-effort branch reuses the SAME source-of-truth spellings
// canonicalMarket() itself matches on, instead of a second hardcoded list).
function _famTypeNames(group) {
    return MARKET_FAMILIES.find(f => f.group === group)?.typeNames ?? [];
}

// A trailing `:1H` / `:2H` / `:<N>m` tag -- appended by canonicalMarket() to
// any family-resolved key when the underlying row carried a period qualifier
// -- marks a period-tagged variant. Stripped up front so every key-shape
// branch below dispatches on the same core key regardless of period tagging;
// raw:/combo: keys never carry this tag (their period info is already baked
// into the slug itself), so stripping is a no-op for them.
const _PERIOD_TAG = /^(.*):(1H|2H|\d+m)$/;

export function marketIdentity(qb, key) {
    const tagMatch = _PERIOD_TAG.exec(key);
    const core = tagMatch ? tagMatch[1] : key;
    const hasPeriod = Boolean(tagMatch);

    // 1) Canonical keys: period-null delegates to the proven builder unchanged;
    //    period-tagged is best-effort (loosened type_name LIKE).
    if (isMarketKey(core)) {
        return hasPeriod ? _canonicalLike(qb, core) : whereMarket(qb, core);
    }

    // 2) Named simple families: period-null exact; period-tagged best-effort.
    if (Object.prototype.hasOwnProperty.call(_SIMPLE_FT_TYPES, core)) {
        if (!hasPeriod) {
            qb.whereIn('type_name', _SIMPLE_FT_TYPES[core]);
        } else {
            qb.whereRaw('LOWER(type_name) LIKE ?', [`%${_SIMPLE_TYPE_LIKE_TOKEN[core]}%`]);
        }
        return _applySimpleFamilyName(qb, core);
    }

    // 3) raw:<type_slug>:<name_slug>[:<handicap>] passthrough (never period-
    //    tagged -- unknown markets carry their period info inside the slug).
    if (core.startsWith('raw:')) {
        const parts = core.split(':');
        const typeSlug = parts[1], nameSlug = parts[2], hc = parts[3];
        qb.whereRaw('LOWER(REPLACE(REPLACE(type_name, " ", "-"), "|", "-")) LIKE ?', [`%${typeSlug}%`]);
        if (nameSlug) qb.whereRaw('LOWER(REPLACE(name, " ", "-")) LIKE ?', [`%${nameSlug}%`]);
        if (hc != null) qb.where('handicap', Number(hc));
        return qb;
    }

    // 4) TT:<ouKey>[:<period>] team-total passthrough: team identity is dropped
    //    from the key by design, so this targets any total-ish type_name plus
    //    the decoded O/U line + side -- best-effort, filter-only. KNOWN
    //    over-match: the '%total%' token also catches 'TOTAL CORNERS' /
    //    'Total Goals Exact' rows sharing the same handicap; excluding
    //    '%corner%'/'%exact%' is a nice-to-have deliberately skipped for M2
    //    (filter-only key, the handicap+side predicate already narrows heavily).
    if (core.startsWith('TT:')) {
        const ouKey = core.split(':')[1];
        const m = /^([OU]) (\d+(?:\.\d+)?)$/.exec(ouKey || '');
        qb.where(b => b.whereRaw('LOWER(type_name) LIKE ?', ['%total%'])
            .orWhereRaw('LOWER(type_name) LIKE ?', ['%over/under%']));
        if (m) {
            qb.where('handicap', Number(m[2]));
            qb.whereRaw('LOWER(name) LIKE ?', [(m[1] === 'O' ? 'over' : 'under') + '%']);
        }
        return qb;
    }

    // 5) combo:<typeSlug>:<nameSlug> passthrough: decode both slugs back onto
    //    type_name/name via LIKE (lossy `_slug()` means this can never be exact).
    if (core.startsWith('combo:')) {
        const [, typeSlug, nameSlug] = core.split(':');
        qb.whereRaw('LOWER(REPLACE(REPLACE(type_name, " ", "-"), "|", "-")) LIKE ?', [`%${typeSlug}%`]);
        if (nameSlug) qb.whereRaw('LOWER(REPLACE(name, " ", "-")) LIKE ?', [`%${nameSlug}%`]);
        return qb;
    }

    // 6) HTFT:<slug> / CS:<slug> (period tag already stripped into `core`):
    //    constrain type_name via a LIKE ALTERNATION over the family's declared
    //    base spellings, in BOTH period states. The family `typeNames` are the
    //    period-STRIPPED bases ('Correct Score'/'CORRECT SCORE',
    //    'Half Time/Full Time'/'HALFTIME/FULLTIME'); the REAL raw type_names
    //    add a period suffix/prefix around that base -- BetPawa's Full-Time
    //    correct-score row is literally 'Correct Score | Full Time' (58,153
    //    rows), NOT the bare 'Correct Score'. Each raw spelling CONTAINS its
    //    base as a substring, so a substring LIKE on the base selects every
    //    provider/period variant; an exact whereIn on the base selected NOTHING
    //    for BetPawa (the majority provider) -- the base-vs-raw trap avoided for
    //    _SIMPLE_FT_TYPES. Best-effort/filter-only: the token also over-matches
    //    the combined 'Half Time/Full Time | Correct Score' market, acceptable
    //    for a filter-only key (the name-slug LIKE narrows further). Tokens
    //    deduped (lowercased) so the two CS spellings don't emit a redundant OR.
    if (core.startsWith('HTFT:') || core.startsWith('CS:')) {
        const group = core.startsWith('HTFT:') ? 'ht_ft' : 'correct_score';
        const tokens = [...new Set(_famTypeNames(group).map(t => t.toLowerCase()))];
        const slug = core.split(':')[1];
        if (tokens.length) {
            qb.where(b => tokens.forEach((t, i) => i === 0
                ? b.whereRaw('LOWER(type_name) LIKE ?', [`%${t}%`])
                : b.orWhereRaw('LOWER(type_name) LIKE ?', [`%${t}%`])));
        }
        if (slug) qb.whereRaw('LOWER(REPLACE(name, " ", "-")) LIKE ?', [`%${slug}%`]);
        return qb;
    }

    // 7) Wholly unrecognized key shape: never crash, never emit type_id -- an
    //    inert name-only LIKE on the key's own slug rather than throwing.
    return qb.whereRaw('LOWER(name) LIKE ?', [`%${_slug(key)}%`]);
}

// Pure predicate: does `key` name a market marketIdentity() can resolve to a
// REAL WHERE (its branches 1-6), as opposed to falling through to the
// non-throwing catch-all (branch 7)? The read layer (records.js _sqlTarget)
// uses this as the sort/filter key-shape gate: an accepted key builds a valid
// MIN(price) pivot; a rejected key returns null -> queryRecords throws ->
// server 400. It MUST mirror marketIdentity()'s recognized branches exactly --
// if a key shape is added/removed there, change it here too, or the gate and
// the builder will drift (a key this accepts but marketIdentity can't resolve
// would build a garbage pivot; a key this rejects but marketIdentity handles
// would 400 a legitimate market).
export function isKnownMarketKey(key) {
    if (typeof key !== 'string' || !key) return false;
    const tagMatch = _PERIOD_TAG.exec(key);
    const core = tagMatch ? tagMatch[1] : key;
    if (isMarketKey(core)) return true;                                            // branch 1: canonical (period-null or -tagged)
    if (Object.prototype.hasOwnProperty.call(_SIMPLE_FT_TYPES, core)) return true; // branch 2: named simple families (GG/NG/DNB/ODD/EVEN)
    return /^(raw:|TT:|combo:|HTFT:|CS:)/.test(core);                              // branches 3-6: passthrough families (test `core`, matching marketIdentity)
}

// --- discoverMarketColumns: market column catalog + coverage threshold (M2 Task 3) ---
// Canonical MARKET_COLUMNS lead the catalog (stable order + their own `default`
// flags) UNCONDITIONALLY -- they are the base column set and must never drop
// out even when the warehouse briefly holds zero/near-zero matching rows.
// Everything else is a market DISCOVERED from odds_markets and is subject to
// the coverage-threshold gate (design note mechanism 2): only markets seen on
// >= `minMatches` distinct matches become catalog entries ('column' or
// 'grouped'); rarer ones stay out of the catalog (never a table column, still
// directly queryable via marketIdentity for a caller holding the raw key).
// 'filter-only' families (correct_score, raw:, ...) are excluded from the
// catalog regardless of coverage -- they are never column-eligible.
//
// CRITICAL: canonicalMarket() UNIFIES multiple raw (type_name,name,handicap)
// spellings into one key (e.g. BetPawa "Both Teams To Score | Full Time" and
// Betika "BOTH TEAMS TO SCORE (GG/NG)" both -> GG), so coverage must be SUMMED
// per canonical key across every raw tuple that maps to it, not judged
// per-tuple -- this is what actually caps the Betika 16k-type_name tail (the
// dynamic team_total/combo/raw markets are almost all thin per exact tuple,
// but some canonical-ish families would be wrongly starved if judged alone).
const DEFAULT_EXTRA_KEYS = new Set(['GG', 'NG', 'DNB1', 'DNB2']); // spec: BTTS + DNB default

// Canonical keys don't round-trip through a row; give them their known group
// via a representative probe row (the OU probe's line/side don't matter -- all
// Over/Under lines share the 'over_under' group).
function _probeRow(key) {
    if (['1', 'X', '2'].includes(key)) return { type_name: '1X2 | Full Time', name: key };
    if (['1X', 'X2', '12'].includes(key)) return { type_name: 'Double Chance | Full Time', name: key };
    return { type_name: 'Over/Under | Full Time', name: 'Over', handicap: 2.5 };
}

// Distinct (type_name,name,handicap) rows carrying a `matches` count
// (count(distinct match_id) per tuple -- the catalog query supplies this) ->
// the ordered market column catalog. Canonical columns first (always
// included), then discovered 'column'/'grouped' families whose SUMMED
// per-canonical-key coverage clears `minMatches` (default 200); 'filter-only'
// markets are excluded outright (available to the filter builder / SQL via a
// separate raw-key path, never as a table column).
export function discoverMarketColumns(rows, { minMatches = 200 } = {}) {
    const seen = new Map(); // key -> catalog entry, canonical MARKET_COLUMNS first
    for (const c of MARKET_COLUMNS) {
        seen.set(c.key, {
            key: c.key, label: c.label, group: canonicalMarket(_probeRow(c.key)).group,
            columnizable: 'column', default: c.default || DEFAULT_EXTRA_KEYS.has(c.key),
            sortable: true, filterable: true,
        });
    }

    // Pass 1: sum `matches` coverage per canonical key across every raw tuple
    // mapping to it. Filter-only markets and tuples already covered by a
    // canonical key are skipped up front -- they never need a threshold.
    const coverage = new Map();   // key -> summed matches
    const descriptor = new Map(); // key -> first-seen canonicalMarket() result
    for (const row of Array.isArray(rows) ? rows : []) {
        const m = canonicalMarket(row);
        if (m.columnizable === 'filter-only') continue;
        if (seen.has(m.key)) continue; // canonical key: already included, coverage-exempt
        coverage.set(m.key, (coverage.get(m.key) || 0) + (Number(row.matches) || 0));
        if (!descriptor.has(m.key)) descriptor.set(m.key, m);
    }

    // Pass 2: admit discovered keys whose SUMMED coverage clears the threshold.
    for (const [key, m] of descriptor) {
        if ((coverage.get(key) || 0) < minMatches) continue;
        seen.set(key, {
            key: m.key, label: m.label, group: m.group, columnizable: m.columnizable,
            default: DEFAULT_EXTRA_KEYS.has(m.key), sortable: true, filterable: true,
        });
    }
    return [...seen.values()];
}
