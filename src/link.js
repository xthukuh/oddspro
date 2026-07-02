import { db } from './db/connection.js';
import { config } from './config.js';

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
            'f.id', 'f.league_id',
            'th.id as home_id', 'th.name as home_name',
            'ta.id as away_id', 'ta.name as away_name',
            'l.name as league_name', 'l.country as league_country',
        );
}

// Link one provider's unlinked, uncompleted matches to canonical fixtures.
async function _linkProvider(provider) {
    const rows = await db('matches')
        .where('provider', provider)
        .whereNull('fixture_id')
        .whereNull('completed_at')
        .select('id', 'start_time', 'home_team_name', 'away_team_name', 'competition_name', 'category_name');
    const counts = { examined: rows.length, alias_linked: 0, fuzzy_linked: 0, unmatched: 0 };
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
        const candidates = await _candidates(m.start_time);
        if (!candidates.length) {
            counts.unmatched++;
            continue;
        }

        // 1) alias fast-path: both team names already known
        let hit = null, viaAlias = false;
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
            if (best && best.conf >= config.LINK_MIN_CONFIDENCE && (best.conf - second) >= MIN_MARGIN) {
                hit = best.c;
            } else if (best && best.conf >= 0.5) {
                console.debug(`[link] ${provider} near-miss (${best.conf.toFixed(3)}): `
                    + `"${m.home_team_name} v ${m.away_team_name}" ~ "${best.c.home_name} v ${best.c.away_name}"`);
            }
        }

        if (!hit) {
            counts.unmatched++;
            continue;
        }

        // 3) persist link + learn aliases for future exact-match correlation
        await db('matches').where('id', m.id).update({ fixture_id: hit.id });
        await db('team_aliases').insert([
            { team_id: hit.home_id, provider, alias_name: m.home_team_name },
            { team_id: hit.away_id, provider, alias_name: m.away_team_name },
        ]).onConflict(['provider', 'alias_name']).ignore();
        teamAliases.set(m.home_team_name, hit.home_id);
        teamAliases.set(m.away_team_name, hit.away_id);
        const comp = m.competition_name || m.category_name;
        if (comp && !leagueAliases.has(comp)) {
            await db('league_aliases').insert({ league_id: hit.league_id, provider, alias_name: comp })
                .onConflict(['provider', 'alias_name']).ignore();
            leagueAliases.set(comp, hit.league_id);
        }
        viaAlias ? counts.alias_linked++ : counts.fuzzy_linked++;
    }
    return counts;
}

// Correlate bookmaker matches to canonical API-Football fixtures.
// Pass a provider to restrict; default processes betpawa then betika.
export async function linkMatches(provider_ = null) {
    const providers = provider_ ? [provider_] : PROVIDER_ORDER;
    const report = {};
    for (const provider of providers) {
        report[provider] = await _linkProvider(provider);
        const c = report[provider];
        console.debug(`[link] ${provider}: ${c.examined} examined, ${c.alias_linked} via alias, `
            + `${c.fuzzy_linked} fuzzy-linked, ${c.unmatched} unmatched.`);
    }
    return report;
}
