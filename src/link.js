import { db } from './db/connection.js';
import { effective } from './settings.js';
import { claimVerdict, orientationVerdict, orientationUpdate, aliasWorthCaching } from './db/link-rules.js';

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

// Sørensen–Dice coefficient over character bigrams (0..1)
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

// Candidate fixtures with kickoff within ±30 min of the match start time
async function _candidates(start_time) {
    return db('fixtures as f')
        .join('teams as th', 'th.id', 'f.home_team_id')
        .join('teams as ta', 'ta.id', 'f.away_team_id')
        .join('leagues as l', 'l.id', 'f.league_id')
        .whereRaw('f.kickoff BETWEEN ? - INTERVAL 30 MINUTE AND ? + INTERVAL 30 MINUTE', [start_time, start_time])
        .select(
            'f.id', 'f.league_id', 'f.kickoff',
            'th.id as home_id', 'th.name as home_name',
            'ta.id as away_id', 'ta.name as away_name',
            'l.name as league_name', 'l.country as league_country',
        );
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
    const counts = { examined: rows.length, alias_linked: 0, fuzzy_linked: 0, unmatched: 0, claims_replaced: 0, claims_skipped: 0, alias_withheld: 0, errors: 0, virtual_skipped: skipped.length };
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
            const candidates = await _candidates(m.start_time);
            if (!candidates.length) {
                counts.unmatched++;
                continue;
            }

            // 1) alias fast-path: both team names already known
            let hit = null, viaAlias = false, score = null;
            const ah = teamAliases.get(m.home_team_name), aa = teamAliases.get(m.away_team_name);
            if (ah && aa) {
                hit = candidates.find(c => c.home_id === ah && c.away_id === aa) ?? null;
                viaAlias = !!hit;
            }

            // 2) fuzzy confidence scoring with runner-up margin
            if (!hit) {
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
                if (best && best.conf >= effective('LINK_MIN_CONFIDENCE') && (best.conf - second) >= MIN_MARGIN) {
                    hit = best.c;
                    score = { conf: best.conf, runnerUp: second };
                } else if (best && best.conf >= 0.5) {
                    console.debug(`[link] ${provider} near-miss (${best.conf.toFixed(3)}): `
                        + `"${m.home_team_name} v ${m.away_team_name}" ~ "${best.c.home_name} v ${best.c.away_name}"`);
                }
            }

            if (!hit) {
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
            await db('matches').where('id', m.id).update({ fixture_id: hit.id });
            const teach = score != null
                && aliasWorthCaching(score.conf, score.runnerUp, effective('LINK_MIN_CONFIDENCE'));
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
            const comp = m.competition_name || m.category_name;
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
            if (apply) await db('matches').where('id', r.id).update({ sides_swapped: next });
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
