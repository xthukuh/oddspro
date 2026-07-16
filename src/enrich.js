import { db } from './db/connection.js';
import { config } from './config.js';
import { effective } from './settings.js';
import { callModel } from './ai/index.js';
import { extractJson } from './ai-parse.js';
import { _batch } from './utils.js';
import {
    selectEnrichable, capFixtures, buildBlindPrompt, buildAnchoredPrompt,
    FactsPayload, BlindPayload, AnchoredPayload, normalizeProbabilities,
    enrichModelTag, resolveTask, FACT_SCHEMA_VER,
} from './db/ai-rules.js';

// M4.1 AI enrichment: three calls per upcoming fixture.
//   1. facts    - grounded Gemini extracts typed facts ONCE
//   2. blind    - a non-Google reasoner sees stats + those facts, NO odds/tip
//   3. anchored - Gemini sees everything, incl. our tip and its price
// Both reasoners work IDENTICAL evidence, so disagreement is reasoning
// difference rather than one model simply knowing more; anchored - blind on the
// same fixture is a PAIRED measurement of the anchoring effect.
//
// COLLECTION ONLY. Nothing here feeds bestTip, confidence or any ranking - that
// is M4.3, answered by replay, not by assertion.
//
// Fail-open throughout: an AI error never breaks the pipeline.

// Same freeze idiom as prematch/tips/hot picks. The kickoff > NOW() filter lives
// in pure ai-rules (selectEnrichable) so it is test-asserted, but we also bound
// it in SQL so a huge warehouse never lands in memory.
//
// fixtures stores only team/league IDs (NOT NULL FKs - see init_schema.js), so
// team/league NAMES require joining teams/leagues, exactly like updateHotPicks'
// own target load in src/hotpicks.js. The brief's f.home_name/f.away_name guess
// does not exist on the fixtures table; fixed here to the real join.
async function _loadTargets() {
    const rows = await db('fixtures as f')
        .join('leagues as l', 'l.id', 'f.league_id')
        .join('teams as th', 'th.id', 'f.home_team_id')
        .join('teams as ta', 'ta.id', 'f.away_team_id')
        .leftJoin('fixture_predictions as fp', 'fp.fixture_id', 'f.id')
        .where('f.kickoff', '>', db.raw('NOW()'))
        .select('f.id', 'f.kickoff', 'l.name as league',
            'th.name as home_name', 'ta.name as away_name',
            'fp.tip_market', 'fp.tip_price')
        .orderBy('f.kickoff', 'asc');
    return rows;
}

async function _existingTags(fixtureIds) {
    if (!fixtureIds.length) return new Map();
    const rows = await db('fixture_ai_insights').whereIn('fixture_id', fixtureIds)
        .select('fixture_id', 'kind', 'provider', 'model_tag');
    const map = new Map();
    for (const r of rows) map.set(`${r.fixture_id}:${r.kind}:${r.provider}`, r.model_tag);
    return map;
}

async function _upsert(row) {
    // 'updated_at' deliberately excluded from merge (same as fixture_predictions'
    // PICK_COLUMNS / fixture_prematch's SNAPSHOT_COLUMNS): MySQL's VALUES(col)
    // resolves to NULL for a column absent from the INSERT list, so merging
    // 'updated_at' here (not present in `row`) would NULL it on every update
    // instead of bumping it. The reuse gate guarantees any real update path
    // carries a genuinely different model_tag, so MySQL's own
    // `ON UPDATE current_timestamp()` fires correctly without help.
    await db('fixture_ai_insights').insert(row).onConflict(['fixture_id', 'kind', 'provider']).merge([
        'model_tag', 'schema_ver', 'payload', 'sources',
    ]);
}

// Reuse gate: skip a call whose stored row already carries the tag we WOULD
// write. Keyed on (fixture, kind, provider, model_tag), so switching model,
// grounding or prompt version re-enriches automatically and a steady-state
// rerun re-bills nothing. Same idiom as the adjudicator's verdict reuse.
function _alreadyFresh(kind, f, tags) {
    const { provider, model, grounded } = resolveTask(kind === 'blind' ? 'blind' : 'anchored', config);
    return tags.get(`${f.id}:${kind}:${provider}`) === enrichModelTag({ model, grounded });
}

// One fixture's full 3-call set. Returns { written, errors }.
async function _enrichOne(f, tags) {
    // Nothing to do -> spend NOTHING. Without this the grounded facts call (the
    // most expensive of the three) would re-bill on every sweep even when both
    // reasoners are already fresh.
    const needBlind = !_alreadyFresh('blind', f, tags);
    const needAnchored = f.tip_market != null && !_alreadyFresh('anchored', f, tags);
    if (!needBlind && !needAnchored) return { written: 0, errors: 0 };

    const stats = {
        fixture: `${f.home_name} - ${f.away_name}`,
        kickoff: f.kickoff, league: f.league,
        // Rolling aggregates are not required for v1 collection; the grounded
        // pass researches context, which is what the warehouse cannot see.
        home: { n: 0, avgTotal: null, gfAvg: null, gaAvg: null, bttsRate: null },
        away: { n: 0, avgTotal: null, gfAvg: null, gaAvg: null, bttsRate: null },
        h2h: { n: 0, avgTotal: null },
    };
    let written = 0, errors = 0, facts = null, sources = null;

    // 1. FACTS (grounded, once).
    try {
        const r = await callModel({ task: 'facts', prompt: _factsPrompt(stats) });
        facts = FactsPayload.parse(extractJson(r.text));
        sources = r.sources ?? null;
    } catch (e) {
        errors++;
        console.warn(`[enrich] facts failed for fixture ${f.id} (continuing unfactualized): ${e.message}`);
    }

    // 2. BLIND (non-Google; identical evidence, no odds/tip).
    // NB the reuse gate wraps the try - it must NOT `return`, or a fresh blind
    // would skip the anchored call below and leave the pair half-measured.
    if (needBlind) {
        try {
            const r = await callModel({ task: 'blind', prompt: buildBlindPrompt({ ...stats, facts }) });
            const p = BlindPayload.parse(extractJson(r.text));
            await _upsert({
                fixture_id: f.id, kind: 'blind', provider: r.provider,
                model_tag: enrichModelTag({ model: r.model, grounded: r.grounded }),
                schema_ver: FACT_SCHEMA_VER,
                payload: JSON.stringify({ facts, probabilities: normalizeProbabilities(p.probabilities), reason: p.reason }),
                sources: sources ? JSON.stringify(sources) : null,
            });
            written++;
        } catch (e) {
            errors++;
            console.warn(`[enrich] blind failed for fixture ${f.id}: ${e.message}`);
        }
    }

    // 3. ANCHORED (sees the tip + price; only meaningful when we HAVE a tip).
    if (needAnchored) {
        try {
            const r = await callModel({
                task: 'anchored',
                prompt: buildAnchoredPrompt({ ...stats, facts, tip: { market: f.tip_market, price: f.tip_price } }),
            });
            const p = AnchoredPayload.parse(extractJson(r.text));
            await _upsert({
                fixture_id: f.id, kind: 'anchored', provider: r.provider,
                model_tag: enrichModelTag({ model: r.model, grounded: r.grounded }),
                schema_ver: FACT_SCHEMA_VER,
                payload: JSON.stringify({ facts, probability: p.probability, consensus: p.consensus, reason: p.reason }),
                sources: r.sources?.length ? JSON.stringify(r.sources) : null,
            });
            written++;
        } catch (e) {
            errors++;
            console.warn(`[enrich] anchored failed for fixture ${f.id}: ${e.message}`);
        }
    }
    return { written, errors };
}

function _factsPrompt({ fixture, kickoff, league }) {
    return [
        'Research this football fixture and report ONLY verified facts.',
        '',
        `Fixture: ${fixture}`,
        `League: ${league ?? 'unknown'}`,
        `Kickoff: ${kickoff}`,
        '',
        'Use web search where available. NEVER assert anything you did not verify -',
        'leave a field out entirely rather than guessing. Absent evidence must stay',
        'distinguishable from "no problem found".',
        '',
        'Reply with ONLY a JSON object, no other text:',
        '{"availability":{"home_out_count":n,"away_out_count":n,',
        '  "home_key_absences":["name"],"away_key_absences":["name"],',
        '  "top_scorer_out":true|false,"first_choice_gk_out":true|false},',
        ' "motivation":{"home_stakes":"dead_rubber|must_win|title_race|relegation|secured|normal",',
        '  "away_stakes":"...","rotation_risk":"low|medium|high"},',
        ' "congestion":{"home_days_since_last":n,"away_days_since_last":n,',
        '  "bigger_match_within_4d":true|false},',
        ' "lineup":{"xi_confirmed":true|false,"manager_change_recent":true|false,"gk_change":true|false},',
        ' "extra":{}}',
    ].join('\n');
}

export async function enrichFixtures() {
    if (!effective('AI_ENRICH_ENABLED')) {
        console.debug('[enrich] AI_ENRICH_ENABLED off - nothing to do.');
        return { fixtures: 0, written: 0, errors: 0, skipped: 0 };
    }
    const all = await _loadTargets();
    // Pure guard, belt AND braces with the SQL filter above.
    const upcoming = selectEnrichable(all);
    const targets = capFixtures(upcoming, Number(effective('AI_ENRICH_CAP')));
    const tags = await _existingTags(targets.map(f => f.id));

    let written = 0, errors = 0;
    // Bounded concurrency: these are NETWORK calls, so the _batch(..., 1) rule
    // for DB writers (InnoDB deadlock avoidance) does not apply here.
    // _batch(list, each, parallel) - verified signature in src/utils.js:51.
    const results = await _batch(
        targets,
        f => _enrichOne(f, tags),
        Number(effective('AI_ENRICH_CONCURRENCY')),
    );
    for (const r of results) { written += r?.written ?? 0; errors += r?.errors ?? 0; }
    return { fixtures: targets.length, written, errors, skipped: upcoming.length - targets.length };
}
