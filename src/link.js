import { db } from './db/connection.js';
import { effective } from './settings.js';
import {
    claimVerdict, orientationVerdict, orientationUpdate, aliasWorthCaching,
    candidateWindows, bucketByMinute, candidatesNear, candidateAttempts,
    CANDIDATE_WINDOW_MINUTES,
} from './db/link-rules.js';

// Correlation order matters: betpawa first (richer identifiers), betika last so
// it can additionally score against betpawa records already linked to a fixture.
const PROVIDER_ORDER = ['betpawa', 'betika'];

// Require the best candidate to beat the runner-up by this much (ambiguity guard)
const MIN_MARGIN = 0.05;

// Noise tokens safe to drop - club-type markers that never distinguish clubs
const NOISE_TOKENS = new Set([
    'fc', 'afc', 'cf', 'sc', 'ac', 'fk', 'cd', 'sv', 'ss', 'bk', 'if', 'club', 'de',
    'jk', 'nk', 'sk', 'ks', 'kf', 'us', 'as', 'cs', 'cr', 'rs',
]);
// Common bookmaker abbreviations + reserve-team marker equivalence (II == B == 2)
const EXPANSIONS = {
    utd: 'united', intl: 'international', dep: 'deportivo', atl: 'atletico',
    ii: '2', iii: '3', b: '2',
};

// Normalize a team/competition name for fuzzy comparison
export function normalizeName(name) {
    return String(name ?? '')
        .toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // strip diacritics
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(w => w && !NOISE_TOKENS.has(w))
        .map(w => EXPANSIONS[w] ?? w)
        .join(' ');
}

// Sørensen-Dice coefficient over character bigrams (0..1)
function _diceBigrams(a, b) {
    const grams = s => {
        const m = new Map();
        for (let i = 0; i < s.length - 1; i++) {
            const g = s.substring(i, i + 2);
            m.set(g, (m.get(g) ?? 0) + 1);
        }
        return m;
    };
    const ga = grams(a), gb = grams(b);
    let overlap = 0, na = 0, nb = 0;
    for (const n of ga.values()) na += n;
    for (const n of gb.values()) nb += n;
    for (const [g, n] of ga) overlap += Math.min(n, gb.get(g) ?? 0);
    return na + nb ? (2 * overlap) / (na + nb) : 0;
}

// Token-level scores: dice over token sets + slightly-discounted overlap
// coefficient (subset containment, e.g. "Lyn" within "Lyn 1896")
function _tokenSim(a, b) {
    const sa = new Set(a.split(' ')), sb = new Set(b.split(' '));
    let inter = 0;
    for (const t of sa) if (sb.has(t)) inter++;
    if (!inter) return 0;
    const dice = (2 * inter) / (sa.size + sb.size);
    const overlap = inter / Math.min(sa.size, sb.size);
    return Math.max(dice, 0.9 * overlap);
}

// Initialism match: "bfa" vs "baltijos futbolo akademija" (discounted)
function _initialismSim(a, b) {
    const [short, long] = a.length <= b.length ? [a, b] : [b, a];
    const tokens = long.split(' ');
    if (!/^[a-z]{2,4}$/.test(short) || short.includes(' ') || tokens.length < 2) return 0;
    return tokens.map(t => t[0]).join('') === short ? 0.9 : 0;
}

// Best-of similarity between two names (0..1)
export function nameSimilarity(a, b) {
    a = normalizeName(a);
    b = normalizeName(b);
    if (!a || !b) return 0;
    if (a === b) return 1;
    return Math.max(_diceBigrams(a, b), _tokenSim(a, b), _initialismSim(a, b));
}

// Combined link confidence for a match/fixture candidate pair.
// `alt` carries team/competition names from a betpawa match already linked to
// the candidate fixture (betika passes score against those too).
function _confidence(m, c, alt) {
    const simH = Math.max(
        nameSimilarity(m.home_team_name, c.home_name),
        alt ? nameSimilarity(m.home_team_name, alt.home_team_name) : 0,
    );
    const simA = Math.max(
        nameSimilarity(m.away_team_name, c.away_name),
        alt ? nameSimilarity(m.away_team_name, alt.away_team_name) : 0,
    );
    const teamScore = 0.5 * simH + 0.5 * simA;
    const comp = m.competition_name || m.category_name;
    if (!comp) return teamScore;
    const targets = [c.league_name];
    if (c.league_country) targets.push(`${c.league_country} ${c.league_name}`);
    if (alt?.competition_name) targets.push(alt.competition_name);
    const simC = Math.max(...targets.map(t => nameSimilarity(comp, t)));
    // Competition agreement is corroborating evidence only - it can lift a
    // borderline team score but never veto identical team names.
    return Math.min(1, teamScore + 0.1 * simC);
}

// Candidate fixtures whose kickoff falls inside one bounded window.
//
// Audit F7: this used to run once PER OPEN ROW with the +/-30 min tolerance
// expressed in SQL (`BETWEEN ? - INTERVAL 30 MINUTE AND ...`). It is now called
// once per contiguous kickoff window of the whole pass - `candidateWindows`
// applies the same tolerance to the window edges - and the per-row pool is cut
// out of the result in memory by `candidatesNear`, which re-applies the exact
// millisecond distance so the pool is byte-for-byte the one the SQL returned.
async function _candidatesInWindow({ from, to }) {
    return db('fixtures as f')
        .join('teams as th', 'th.id', 'f.home_team_id')
        .join('teams as ta', 'ta.id', 'f.away_team_id')
        .join('leagues as l', 'l.id', 'f.league_id')
        .whereBetween('f.kickoff', [from, to])
        .select(
            'f.id', 'f.league_id', 'f.kickoff',
            'th.id as home_id', 'th.name as home_name',
            'ta.id as away_id', 'ta.name as away_name',
            'l.name as league_name', 'l.country as league_country',
        );
}

// Score one candidate pool for one match: alias fast path, then fuzzy
// confidence with the runner-up margin. Returns the hit (or null) plus the
// best-scoring candidate, which the caller needs for the near-miss log.
//
// Unchanged from the pre-F7 inline version except that the pool is now passed
// in - the SAME scorer, floor and margin run whether the pool is the league
// slice or the full time bucket. NB the runner-up margin is measured inside the
// pool being scored, so a league-scoped pass asks "is this unambiguous within
// the league the bookmaker named", which is the question it should be asking;
// an ambiguous scoped pass simply falls through to the full bucket.
function _scorePool(m, candidates, { teamAliases, betpawaByFixture, threshold }) {
    const ah = teamAliases.get(m.home_team_name), aa = teamAliases.get(m.away_team_name);
    if (ah && aa) {
        const hit = candidates.find(c => c.home_id === ah && c.away_id === aa) ?? null;
        if (hit) return { hit, viaAlias: true, score: null, best: null };
    }
    let best = null, second = 0;
    for (const c of candidates) {
        const conf = _confidence(m, c, betpawaByFixture.get(c.id));
        if (!best || conf > best.conf) {
            second = best?.conf ?? 0;
            best = { c, conf };
        } else if (conf > second) {
            second = conf;
        }
    }
    if (best && best.conf >= threshold && (best.conf - second) >= MIN_MARGIN) {
        return { hit: best.c, viaAlias: false, score: { conf: best.conf, runnerUp: second }, best };
    }
    return { hit: null, viaAlias: false, score: null, best };
}

// Link one provider's unlinked, uncompleted matches to canonical fixtures.
async function _linkProvider(provider) {
    // Audit F5: `is_virtual` rows are simulated competitions (Betika -Zoom /
    // SRL). API-Football cannot carry a fixture that does not exist, so these
    // can never link - but without this filter they were re-scored against the
    // full candidate pool every 10 minutes until the 4h completion fallback
    // closed them. They are excluded from the WORK, never from the warehouse:
    // the rows keep their odds and the web layer still serves them.
    const skipped = await db('matches')
        .where('provider', provider)
        .whereNull('fixture_id')
        .whereNull('completed_at')
        .where('is_virtual', true)
        .select('competition_name');
    const rows = await db('matches')
        .where('provider', provider)
        .whereNull('fixture_id')
        .whereNull('completed_at')
        .where('is_virtual', false)
        .select('id', 'start_time', 'home_team_name', 'away_team_name', 'competition_name', 'category_name');
    const counts = {
        examined: rows.length, alias_linked: 0, fuzzy_linked: 0, unmatched: 0,
        claims_replaced: 0, claims_skipped: 0, alias_withheld: 0, errors: 0,
        virtual_skipped: skipped.length,
        // Audit F7 instrumentation: how many candidate queries the pass cost
        // (it was one PER ROW), how big the widest per-row pool got, and how
        // often the league alias narrowed it / failed to carry.
        candidate_queries: 0, candidates_loaded: 0, candidates_max: 0,
        league_scoped: 0, league_fallback: 0,
    };
    // Report the DISTINCT names skipped, not just the count: a false positive
    // orphans a real match silently, and the name is the only thing that would
    // let an operator notice it on the very first pass it happens.
    if (skipped.length) {
        counts.virtual_names = [...new Set(skipped.map(r => r.competition_name))].sort();
    }
    if (!rows.length) return counts;

    // Alias caches (learned from previous confident links)
    const teamAliases = new Map((await db('team_aliases').where('provider', provider)
        .select('alias_name', 'team_id')).map(r => [r.alias_name, r.team_id]));
    const leagueAliases = new Map((await db('league_aliases').where('provider', provider)
        .select('alias_name', 'league_id')).map(r => [r.alias_name, r.league_id]));

    // Audit F7: ONE candidate query per contiguous kickoff window of the whole
    // pass, bucketed by kickoff minute in memory, instead of one query per row.
    // The windows are bounded by the open rows' own start_time range plus the
    // tolerance, and split on gaps wider than CANDIDATE_WINDOW_MAX_GAP_MINUTES,
    // so an overnight lull is never scanned and one stray row cannot stretch
    // the range across years - the live host kills long scans.
    const windows = candidateWindows(rows.map(r => r.start_time));
    const pool = [];
    // Appended one by one, never spread: a spread of a very large result array
    // is a call with that many arguments, which blows the stack.
    for (const w of windows) for (const c of await _candidatesInWindow(w)) pool.push(c);
    counts.candidate_queries = windows.length;
    counts.candidates_loaded = pool.length;
    const buckets = bucketByMinute(pool);

    // For betika: names of betpawa matches already linked to fixtures
    let betpawaByFixture = new Map();
    if (provider === 'betika') {
        const bp = await db('matches').where('provider', 'betpawa').whereNotNull('fixture_id')
            .select('fixture_id', 'home_team_name', 'away_team_name', 'competition_name');
        betpawaByFixture = new Map(bp.map(r => [r.fixture_id, r]));
    }

    for (const m of rows) {
        // Per-row isolation (2026-08-19 audit F8): none of the three writes
        // below is deadlock-retried, and without this guard a single row's
        // transient DB error aborted the whole provider AND - because
        // linkMatches runs providers sequentially - every provider after it.
        // The pass is idempotent, so skipping one row costs nothing but one
        // cycle: it is simply re-examined next pass.
        try {
            const candidates = candidatesNear(buckets, m.start_time, CANDIDATE_WINDOW_MINUTES);
            if (!candidates.length) {
                counts.unmatched++;
                continue;
            }
            if (candidates.length > counts.candidates_max) counts.candidates_max = candidates.length;

            // 1+2) alias fast-path then fuzzy scoring, run over the LEAGUE-scoped
            // pool first when league_aliases resolves this competition (audit F7,
            // and the answer to F6's write-only table). Scoping is a preference,
            // never a veto: if the scoped pool yields no acceptable link we score
            // the full time bucket exactly as before, so a stale or missing alias
            // costs one extra scoring pass and never a lost link.
            const comp = m.competition_name || m.category_name;
            const leagueId = comp ? (leagueAliases.get(comp) ?? null) : null;
            const threshold = effective('LINK_MIN_CONFIDENCE');
            let hit = null, viaAlias = false, score = null, best = null, scope = null;
            for (const attempt of candidateAttempts(candidates, leagueId)) {
                const r = _scorePool(m, attempt.rows, { teamAliases, betpawaByFixture, threshold });
                best = r.best;
                if (r.hit) {
                    hit = r.hit; viaAlias = r.viaAlias; score = r.score; scope = attempt.scope;
                    break;
                }
                if (attempt.scope === 'league') counts.league_fallback++;
            }
            if (hit && scope === 'league') counts.league_scoped++;

            if (!hit) {
                // The near-miss line reports the LAST attempt's best, i.e. the
                // full pool's - the same candidate the pre-F7 pass reported.
                if (best && best.conf >= 0.5) {
                    console.debug(`[link] ${provider} near-miss (${best.conf.toFixed(3)}): `
                        + `"${m.home_team_name} v ${m.away_team_name}" ~ "${best.c.home_name} v ${best.c.away_name}"`);
                }
                counts.unmatched++;
                continue;
            }

            // 3) contest the claim BEFORE writing. One canonical fixture may be
            // held by at most one match per provider: when API-Football reschedules
            // a fixture the bookmaker relists the game under a new
            // provider_match_id, and if the old listing keeps the link the settle
            // pass (which joins on m.fixture_id = f.id) stamps the eventual score
            // onto BOTH - showing a result under the ORIGINAL, never-played date.
            // The listing whose start_time sits closest to the canonical kickoff
            // wins; see src/db/link-rules.js for the (offline-tested) rule.
            const claim = await db('matches')
                .where('provider', provider).where('fixture_id', hit.id)
                .select('id', 'start_time').first();
            const verdict = claimVerdict({ existing: claim ?? null, incoming: m, kickoff: hit.kickoff });
            if (verdict === 'skip') {
                counts.claims_skipped++;
                continue;   // deliberately no alias learning - we did not link
            }
            if (verdict === 'replace') {
                // Unlink the stale listing AND clear the scores it inherited from
                // the fixture: leaving them behind is exactly the visible
                // corruption this guard exists to remove. completed_at is left
                // alone - it is a one-way door (see the fetch-throttling
                // invariant), and reopening a dead provider_match_id would only
                // buy pointless odds requests.
                await db('matches').where('id', claim.id).update({
                    fixture_id: null,
                    home_score_fulltime: null, away_score_fulltime: null,
                    home_score_first_half: null, away_score_first_half: null,
                    home_score_second_half: null, away_score_second_half: null,
                    // Audit F10: updated_at is ON UPDATE CURRENT_TIMESTAMP and
                    // the web shows it as the odds refresh time; pin it - this
                    // write refreshes no odds.
                    updated_at: db.raw('updated_at'),
                });
                counts.claims_replaced++;
                console.debug(`[link] ${provider}: match ${claim.id} lost fixture ${hit.id} to ${m.id} (reschedule)`);
            }

            // 4) persist the link. Learning an alias is a SEPARATE, stricter
            // decision: an alias short-circuits the scorer for every future
            // fixture of those teams, it is never re-validated, and nothing in
            // the repo can delete one - so a link accepted at the very edge of
            // the gate must not become a permanent rule (audit F3,
            // aliasWorthCaching). An alias-path link teaches nothing new anyway.
            // updated_at pinned (audit F10): linking is not an odds refresh.
            await db('matches').where('id', m.id).update({
                fixture_id: hit.id, updated_at: db.raw('updated_at'),
            });
            const teach = score != null
                && aliasWorthCaching(score.conf, score.runnerUp, threshold);
            if (teach) {
                await db('team_aliases').insert([
                    { team_id: hit.home_id, provider, alias_name: m.home_team_name },
                    { team_id: hit.away_id, provider, alias_name: m.away_team_name },
                ]).onConflict(['provider', 'alias_name']).ignore();
                teamAliases.set(m.home_team_name, hit.home_id);
                teamAliases.set(m.away_team_name, hit.away_id);
            } else if (score != null) {
                counts.alias_withheld++;
            }
            if (teach && comp && !leagueAliases.has(comp)) {
                await db('league_aliases').insert({ league_id: hit.league_id, provider, alias_name: comp })
                    .onConflict(['provider', 'alias_name']).ignore();
                leagueAliases.set(comp, hit.league_id);
            }
            viaAlias ? counts.alias_linked++ : counts.fuzzy_linked++;
        } catch (e) {
            counts.errors++;
            console.error(`[link] ${provider} row ${m.id} failed: ${e?.message ?? e}`);
        }
    }
    return counts;
}

// Re-validate the home/away orientation of EXISTING links.
//
// A link is written once and never re-checked, but API-Football keeps
// `home_team_id`/`away_team_id` in its fixtures upsert merge list, so it can
// swap a fixture's sides AFTER we linked it (seen on neutral-venue ties and
// friendlies). The link stays correct - same teams, same kickoff - but the read
// layer pairs the BOOKMAKER's names with the CANONICAL score, so the row then
// renders a result the wrong way round (fixture 1548857 showed "FC Annecy - FC
// Sion 4-0" when Sion won 4-0). This pass detects that and stamps
// `matches.sides_swapped`, which src/db/records.js reads to swap the displayed
// score. Nothing about the stored scores or the settle SQL changes.
//
// `sinceDays` bounds the scan (default 30, null = all history for the one-off
// repair script): the shared host punishes unbounded scans, and a fixture whose
// sides flip does so around its kickoff, not years later.
export async function revalidateOrientation({ sinceDays = 30, apply = true } = {}) {
    const q = db('matches as m')
        .join('fixtures as f', 'f.id', 'm.fixture_id')
        .join('teams as th', 'th.id', 'f.home_team_id')
        .join('teams as ta', 'ta.id', 'f.away_team_id')
        .whereNotNull('m.fixture_id')
        .select('m.id', 'm.provider', 'm.sides_swapped', 'm.home_team_name as mh',
            'm.away_team_name as ma', 'th.name as fh', 'ta.name as fa', 'm.fixture_id');
    if (sinceDays != null) q.whereRaw('f.kickoff >= NOW() - INTERVAL ? DAY', [sinceDays]);
    const rows = await q;

    const counts = { examined: rows.length, swapped: 0, straightened: 0, unchanged: 0, errors: 0 };
    for (const r of rows) {
        try {
            const straight = 0.5 * nameSimilarity(r.mh, r.fh) + 0.5 * nameSimilarity(r.ma, r.fa);
            const flip = 0.5 * nameSimilarity(r.mh, r.fa) + 0.5 * nameSimilarity(r.ma, r.fh);
            const next = orientationUpdate(orientationVerdict(straight, flip), r.sides_swapped);
            if (next === null) {
                counts.unchanged++;
                continue;
            }
            next ? counts.swapped++ : counts.straightened++;
            console.debug(`[link] ${r.provider} match ${r.id} (fixture ${r.fixture_id}) sides_swapped -> ${next}: `
                + `"${r.mh} v ${r.ma}" vs canonical "${r.fh} v ${r.fa}" `
                + `(straight ${straight.toFixed(2)}, flipped ${flip.toFixed(2)})`);
            if (apply) {
                // updated_at pinned (audit F10): a display-flag write is not an
                // odds refresh.
                await db('matches').where('id', r.id).update({
                    sides_swapped: next, updated_at: db.raw('updated_at'),
                });
            }
        } catch (e) {
            counts.errors++;
            console.error(`[link] orientation check failed for match ${r.id}: ${e?.message ?? e}`);
        }
    }
    return counts;
}

// Correlate bookmaker matches to canonical API-Football fixtures.
// Pass a provider to restrict; default processes betpawa then betika.
export async function linkMatches(provider_ = null) {
    const providers = provider_ ? [provider_] : PROVIDER_ORDER;
    const report = {};
    for (const provider of providers) {
        // Provider isolation: betpawa throwing must never mean betika is
        // skipped entirely for the pass (the same cascade class that cost
        // three days of odds on 2026-08-16).
        try {
            report[provider] = await _linkProvider(provider);
        } catch (e) {
            report[provider] = { error: String(e?.message ?? e) };
            console.error(`[link] ${provider} pass failed: ${e?.message ?? e}`);
            continue;
        }
        const c = report[provider];
        console.debug(`[link] ${provider}: ${c.examined} examined, ${c.alias_linked} via alias, `
            + `${c.fuzzy_linked} fuzzy-linked, ${c.unmatched} unmatched`
            + `${c.examined ? `, ${c.candidate_queries} candidate ${c.candidate_queries === 1 ? 'query' : 'queries'}`
                + ` (${c.candidates_loaded} fixtures, max ${c.candidates_max}/row)` : ''}`
            + `${c.league_scoped ? `, ${c.league_scoped} league-scoped` : ''}`
            + `${c.league_fallback ? `, ${c.league_fallback} league fallbacks` : ''}`
            + `${c.claims_replaced ? `, ${c.claims_replaced} reschedule claims replaced` : ''}`
            + `${c.claims_skipped ? `, ${c.claims_skipped} claims skipped` : ''}`
            + `${c.errors ? `, ${c.errors} row errors` : ''}`
            + `${c.virtual_skipped ? `, ${c.virtual_skipped} virtual skipped (${c.virtual_names.join(', ')})` : ''}.`);
    }
    // Orientation re-validation runs AFTER the providers, once, over the links
    // that now exist. Guarded: it is a correctness nicety on the display layer,
    // never a reason to fail a pass that correlated matches successfully.
    try {
        report.orientation = await revalidateOrientation();
        const o = report.orientation;
        if (o.swapped || o.straightened || o.errors) {
            console.debug(`[link] orientation: ${o.examined} checked, ${o.swapped} marked swapped, `
                + `${o.straightened} straightened, ${o.errors} errors.`);
        }
    } catch (e) {
        report.orientation = { error: String(e?.message ?? e) };
        console.error(`[link] orientation re-validation failed: ${e?.message ?? e}`);
    }
    return report;
}
