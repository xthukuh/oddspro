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
    KICKOFF_SQL_EXPR, CORRELATION_GUARDS, insightIsFresh,
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
//
// Review finding 1 (TZ HAZARD): kickoff is projected via KICKOFF_SQL_EXPR
// (an explicit +03:00-offset STRING), never the bare `f.kickoff` column -
// mysql2 decodes a bare DATETIME using the NODE PROCESS's local timezone,
// not the pinned SQL session, so selectEnrichable's leakage guard could
// admit an already-started fixture off-EAT. See ai-rules.js's comment on
// KICKOFF_SQL_EXPR and tests/enrich-rules.test.js's TZ HAZARD tests. The SQL
// `where kickoff > NOW()` below stays too (the session IS pinned +03:00, so
// it is correct) - belt AND braces, now both actually load-bearing.
//
// Review finding 3 (CAP-WASTE): CORRELATION_GUARDS mirrors hotpicks.js's own
// upcoming-fixture target loader (src/hotpicks.js:129-130) - without them, an
// uncorrelated or snapshot-less fixture burns a facts+blind call while
// needAnchored is false, wasting an AI_ENRICH_CAP slot on a fixture that can
// never pair.
//
// Fix pass 2, finding A: extracted from `_loadTargets` (was inline) into its
// own exported function so the leakage-critical binding to KICKOFF_SQL_EXPR
// and the `kickoff > NOW()` filter is assertable OFFLINE, with no DB
// connection. Takes a knex/query-builder factory (`knex`) instead of closing
// over the module's connected `db` singleton, so a test can pass a
// disconnected `knex({ client: 'mysql2' })` instance (same idiom as
// tests/market-identity.test.js) and call `.toSQL().sql` on the result -
// `.toSQL()` only compiles SQL, it never opens a connection. Before this
// split, reverting the KICKOFF_SQL_EXPR projection (or the strict
// `kickoff > NOW()` filter) back to something permissive left all tests
// green, because nothing exercised the QUERY - only the constant's own
// string and the pure selectEnrichable() guard were pinned. This is the
// least invasive shape that closes that gap: no new module, no behaviour
// change, `_loadTargets` becomes a two-line caller that awaits it.
export function buildTargetsQuery(knex) {
    return knex('fixtures as f')
        .join('leagues as l', 'l.id', 'f.league_id')
        .join('teams as th', 'th.id', 'f.home_team_id')
        .join('teams as ta', 'ta.id', 'f.away_team_id')
        .leftJoin('fixture_predictions as fp', 'fp.fixture_id', 'f.id')
        .where('f.kickoff', '>', knex.raw('NOW()'))
        .whereRaw(CORRELATION_GUARDS[0])
        .whereRaw(CORRELATION_GUARDS[1])
        .select('f.id', knex.raw(`${KICKOFF_SQL_EXPR} as kickoff`), 'l.name as league',
            'th.name as home_name', 'ta.name as away_name',
            'fp.tip_market', 'fp.tip_price');
    // No .orderBy here (review finding 5) - selectEnrichable() (pure,
    // test-asserted) re-sorts soonest-first right after this returns, and
    // nothing here LIMITs the SQL result, so a SQL-side order would sort a
    // set that gets fully re-sorted a moment later for zero benefit. One
    // sort, one place.
}

async function _loadTargets() {
    return await buildTargetsQuery(db);
}

// Review finding 2 (tip-identity reuse gate): loads `payload` too, not just
// `model_tag` - an 'anchored' row's stored tip identity (see _upsert below)
// must be compared against the fixture's CURRENT tip, because bestTip
// re-updates on every hotpicks run and a changed tip must re-fire the
// anchored call even when model_tag is unchanged. See ai-rules.js's
// insightIsFresh for the freshness decision itself.
async function _existingTags(fixtureIds) {
    if (!fixtureIds.length) return new Map();
    const rows = await db('fixture_ai_insights').whereIn('fixture_id', fixtureIds)
        .select('fixture_id', 'kind', 'provider', 'model_tag', 'payload');
    const map = new Map();
    for (const r of rows) {
        // mysql2 may return a JSON column as an object or a string depending
        // on driver flags (same hazard as records.js's `_json`) - tolerate
        // both.
        let payload = r.payload;
        if (typeof payload === 'string') {
            try { payload = JSON.parse(payload); } catch { payload = null; }
        }
        const tip = r.kind === 'anchored' ? (payload?.tip ?? null) : null;
        map.set(`${r.fixture_id}:${r.kind}:${r.provider}`, { model_tag: r.model_tag, tip });
    }
    return map;
}

async function _upsert(row) {
    // 'updated_at' deliberately excluded from merge (same as fixture_predictions'
    // PICK_COLUMNS / fixture_prematch's SNAPSHOT_COLUMNS): MySQL's VALUES(col)
    // resolves to NULL for a column absent from the INSERT list, so merging
    // 'updated_at' here (not present in `row`) would NULL it on every update
    // instead of bumping it. The reuse gate (_alreadyFresh/insightIsFresh)
    // guarantees any real update path carries either a genuinely different
    // model_tag OR (fix pass 2, finding B - the tip-identity fix deliberately
    // re-fires 'anchored' with an UNCHANGED model_tag when the tip moved on)
    // a genuinely different payload, so MySQL's own
    // `ON UPDATE current_timestamp()` still fires correctly without help -
    // it triggers on any changed column value in the UPDATE, not on
    // model_tag specifically.
    await db('fixture_ai_insights').insert(row).onConflict(['fixture_id', 'kind', 'provider']).merge([
        'model_tag', 'schema_ver', 'payload', 'sources',
    ]);
}

// Reuse gate: skip a call whose stored row already carries the tag we WOULD
// write. Keyed on (fixture, kind, provider, model_tag) - PLUS tip identity
// for 'anchored' (finding 2: bestTip re-updates on every hotpicks run, so a
// changed tip_market/tip_price must re-fire the anchored call even when
// model_tag is unchanged, or the stored payload silently measures anchoring
// against a tip the model never saw). So switching model, grounding, prompt
// version OR tip re-enriches automatically, and a steady-state rerun
// re-bills nothing. Same idiom as the adjudicator's verdict reuse. The
// freshness decision itself is pure (ai-rules.js#insightIsFresh, tested).
function _alreadyFresh(kind, f, tags) {
    const { provider, model, grounded } = resolveTask(kind === 'blind' ? 'blind' : 'anchored', config);
    const stored = tags.get(`${f.id}:${kind}:${provider}`);
    return insightIsFresh(kind, enrichModelTag({ model, grounded }), stored, { market: f.tip_market, price: f.tip_price });
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
            const tip = { market: f.tip_market, price: f.tip_price };
            const r = await callModel({
                task: 'anchored',
                prompt: buildAnchoredPrompt({ ...stats, facts, tip }),
            });
            const p = AnchoredPayload.parse(extractJson(r.text));
            await _upsert({
                fixture_id: f.id, kind: 'anchored', provider: r.provider,
                model_tag: enrichModelTag({ model: r.model, grounded: r.grounded }),
                schema_ver: FACT_SCHEMA_VER,
                // `tip` recorded verbatim (finding 2): the reuse gate
                // (_alreadyFresh/insightIsFresh) reads it back on the NEXT
                // run to tell "tip unchanged" apart from "tip moved on" -
                // without it, M4.2/M4.3 would join this insight to whatever
                // the CURRENT tip happens to be, silently mis-attributing
                // the anchoring measurement to a bet the model never saw.
                payload: JSON.stringify({ facts, tip, probability: p.probability, consensus: p.consensus, reason: p.reason }),
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
    // Review finding 4: resolveTask('blind', ...) THROWS on a misconfigured
    // Google blind model (reasoner independence is a hard requirement - see
    // ai-rules.js#resolveTask). That is a deterministic misconfiguration, so
    // failing fast is correct - but _alreadyFresh called it from INSIDE each
    // _batch worker with no surrounding try/catch, so the first fixture
    // processed would throw mid-sweep and abort the whole run via _batch's
    // reject path. Validate once, here, before any fixture is touched or any
    // call is made, so a bad config fails loudly and immediately instead of
    // N-times-over from wherever _batch happened to schedule it first.
    resolveTask('blind', config);
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
