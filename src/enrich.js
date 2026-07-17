import { db } from './db/connection.js';
import { config } from './config.js';
import { effective, effectiveConfig } from './settings.js';
import { getProvider } from './ai/index.js';
import { callStructured } from './ai/harness.js';
import { newRunGuard } from './db/ai-guard-rules.js';
import { _batch } from './utils.js';
import { pairedTeamGoalsAggregates, h2hGoalsAggregates } from './db/goals-rules.js';
import { loadTeamHistory } from './hotpicks.js';
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
        // 'f.home_team_id'/'f.away_team_id' (FINAL REVIEW finding 1): the
        // rolling-stats aggregates (_buildStats below, via loadTeamHistory +
        // pairedTeamGoalsAggregates/h2hGoalsAggregates) are keyed on team id,
        // not name - without these two columns _buildStats would have no way
        // to look a fixture's teams up in the bulk history map.
        .select('f.id', knex.raw(`${KICKOFF_SQL_EXPR} as kickoff`), 'l.name as league',
            'f.home_team_id', 'f.away_team_id',
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
function _alreadyFresh(kind, f, tags, cfg) {
    const { provider, model, grounded } = resolveTask(kind === 'blind' ? 'blind' : 'anchored', cfg);
    const stored = tags.get(`${f.id}:${kind}:${provider}`);
    return insightIsFresh(kind, enrichModelTag({ model, grounded }), stored, { market: f.tip_market, price: f.tip_price });
}

// FINAL REVIEW finding 1 (THE USER HAS RULED - spec §3.1 governs): both
// reasoners must see "teams, date, our rolling stats" - this was a hardcoded
// { n:0, avgTotal:null, ... } placeholder before, which made ai-rules.js's
// _team render literal "null"s. Reuses the EXACT warehouse machinery
// src/hotpicks.js already computes hot picks from - loadTeamHistory (shared
// export, src/hotpicks.js) + pairedTeamGoalsAggregates/h2hGoalsAggregates
// (src/db/goals-rules.js, the SAME fairness-paired windows hotpicks.js
// itself uses) - never a second, drifting definition of "recent form".
// `fixturesByTeam` is loaded ONCE per enrichFixtures() run, scoped to only
// the CAPPED targets (a fixture we will never call AI on costs a history
// query for nothing).
//
// The returned shape feeds BOTH buildBlindPrompt and buildAnchoredPrompt via
// `{ ...stats, facts }` / `{ ...stats, facts, tip }` (see _enrichOne below) -
// the projection is IDENTICAL for both by construction (one function, one
// call site per fixture), which is what keeps `anchored - blind` a clean
// paired measurement. A genuinely sample-less side/H2H is NOT special-cased
// here - teamGoalsAggregates/h2hGoalsAggregates already return { n: 0, ... }
// for that case, and ai-rules.js's _team/buildBlindPrompt/buildAnchoredPrompt
// (pure, zod-only) are what OMIT that line rather than render `null`.
function _buildStats(f, fixturesByTeam, cfg) {
    const cutoff = new Date(f.kickoff).getTime();
    const homeRows = fixturesByTeam.get(f.home_team_id) ?? [];
    const awayRows = fixturesByTeam.get(f.away_team_id) ?? [];
    const pair = pairedTeamGoalsAggregates(
        homeRows, awayRows, f.home_team_id, f.away_team_id, cutoff, cfg.HOTPICK_TEAM_WINDOW,
    );
    const h2h = h2hGoalsAggregates(homeRows, f.home_team_id, f.away_team_id, cutoff, cfg.PREMATCH_H2H_WINDOW);
    return {
        fixture: `${f.home_name} - ${f.away_name}`,
        kickoff: f.kickoff, league: f.league,
        home: pair.home, away: pair.away, h2h,
    };
}

// One fixture's full 3-call set. Returns { written, errors }.
// All three calls ride callStructured (T9): sanitize -> extractJson ->
// per-kind zod schema -> observe-only suspicion flags, plus the shared
// per-run guard - prompt bytes and tags are UNCHANGED, so nothing re-bills.
async function _enrichOne(f, tags, fixturesByTeam, cfg, guard) {
    // Nothing to do -> spend NOTHING. Without this the grounded facts call (the
    // most expensive of the three) would re-bill on every sweep even when both
    // reasoners are already fresh.
    const needBlind = !_alreadyFresh('blind', f, tags, cfg);
    const needAnchored = f.tip_market != null && !_alreadyFresh('anchored', f, tags, cfg);
    if (!needBlind && !needAnchored) return { written: 0, errors: 0 };

    const stats = _buildStats(f, fixturesByTeam, cfg);
    let written = 0, errors = 0, facts = null, sources = null;

    // 1. FACTS (grounded, once).
    try {
        const r = await callStructured({ task: 'facts', prompt: _factsPrompt(stats), schema: FactsPayload, cfg, guard });
        facts = r.data;
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
            const r = await callStructured({ task: 'blind', prompt: buildBlindPrompt({ ...stats, facts }), schema: BlindPayload, cfg, guard });
            const p = r.data;
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
            const r = await callStructured({
                task: 'anchored',
                prompt: buildAnchoredPrompt({ ...stats, facts, tip }),
                schema: AnchoredPayload,
                cfg,
                guard,
            });
            const p = r.data;
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

// FINAL REVIEW finding 3 (dead settings control): OPENROUTER_MODEL /
// AI_BLIND_MODEL / AI_ANCHORED_MODEL are SETTINGS_CATALOG entries flagged
// live:true, but resolveTask/callModel used to always read the raw immutable
// `config` object - src/settings.js's admin-override cache was NEVER
// consulted, so an admin edit to any of the three was a PERMANENT no-op (not
// even a restart applied it: config.js reads process.env once at import and
// never again). This builds the cfg object resolveTask/callModel actually
// use: config defaults with every catalog override layered on top, via the
// SAME mergeOverrides() settings.effectiveConfig() already uses for every
// other admin-editable knob (SAFE_*, refresh cadences, ...) - one definition
// of "effective", not two.
//
// `overridesFn` is injected (same DI idiom as buildTargetsQuery's `knex`
// param above) so the wiring itself - "does the built cfg actually reflect
// an override" - is assertable OFFLINE without priming settings.js's real
// DB-backed cache (calling the real effectiveConfig() is ALSO offline-safe
// when the cache is unloaded - it just returns catalog defaults - but a test
// should not depend on that module's private state to prove this).
export function effectiveAiConfig(overridesFn = effectiveConfig) {
    return { ...config, ...overridesFn() };
}

// FINAL REVIEW finding 4 (no API-key preflight): with AI_ENRICH_ENABLED on
// and one provider's key missing, every fixture used to bill the (expensive)
// grounded Gemini facts call and then throw on the blind call - producing
// anchored-with-no-blind on EVERY fixture (the mirror of the unpaired state
// AI_ENRICH_CAP exists to prevent) at full Gemini cost, silently, for the
// whole run. Extracted so the assertion is testable OFFLINE via booleans the
// caller already resolved (getProvider(name).enabled()), rather than this
// function reaching into config/.env itself - a test can simulate "key
// missing" without touching this machine's real .env at all.
export function assertAiProvidersConfigured({ geminiEnabled, openrouterEnabled }) {
    if (!geminiEnabled) {
        throw new Error('AI_ENRICH_ENABLED is on but GEMINI_API_KEY is unset - the facts/anchored calls need it.');
    }
    if (!openrouterEnabled) {
        throw new Error('AI_ENRICH_ENABLED is on but OPENROUTER_API_KEY is unset - the blind reasoner needs it.');
    }
}

export async function enrichFixtures() {
    if (!effective('AI_ENRICH_ENABLED')) {
        console.debug('[enrich] AI_ENRICH_ENABLED off - nothing to do.');
        return { fixtures: 0, written: 0, errors: 0, skipped: 0 };
    }
    // Built ONCE per run: a stable snapshot for the whole sweep, not a value
    // that could drift mid-run under a concurrent admin edit.
    const cfg = effectiveAiConfig();

    // Review finding 4 (Task 6 fix pass): resolveTask('blind', ...) THROWS on
    // a misconfigured Google blind model (reasoner independence is a hard
    // requirement - see ai-rules.js#resolveTask). That is a deterministic
    // misconfiguration, so failing fast is correct - but _alreadyFresh called
    // it from INSIDE each _batch worker with no surrounding try/catch, so the
    // first fixture processed would throw mid-sweep and abort the whole run
    // via _batch's reject path. Validate once, here, before any fixture is
    // touched or any call is made, so a bad config fails loudly and
    // immediately instead of N-times-over from wherever _batch happened to
    // schedule it first.
    resolveTask('blind', cfg);

    // FINAL REVIEW finding 4: an unset provider key is ALSO a deterministic
    // misconfiguration that must be caught HERE, before a single call is
    // billed - see assertAiProvidersConfigured's own comment.
    assertAiProvidersConfigured({
        geminiEnabled: getProvider('gemini').enabled(),
        openrouterEnabled: getProvider('openrouter').enabled(),
    });

    const all = await _loadTargets();
    // Pure guard, belt AND braces with the SQL filter above.
    const upcoming = selectEnrichable(all);
    const targets = capFixtures(upcoming, Number(effective('AI_ENRICH_CAP')));
    const tags = await _existingTags(targets.map(f => f.id));

    // FINAL REVIEW finding 1: rolling stats loaded ONCE, scoped to exactly the
    // capped targets (a fixture we will never call AI on costs a history
    // query for nothing) - see loadTeamHistory (src/hotpicks.js) +
    // _buildStats above.
    const teamIds = [...new Set(targets.flatMap(f => [f.home_team_id, f.away_team_id]))];
    const fixturesByTeam = await loadTeamHistory(teamIds);

    let written = 0, errors = 0;
    // T9 run guard, one per sweep: wall-clock budget (AI_RUN_MAX_MINUTES,
    // 0 = off) + circuit breaker (AI_BREAKER_AFTER consecutive failures).
    // Refusals surface as counted per-call errors (fail-open), never batch
    // rejections.
    const guard = newRunGuard(Date.now());
    // Bounded concurrency: these are NETWORK calls, so the _batch(..., 1) rule
    // for DB writers (InnoDB deadlock avoidance) does not apply here.
    // _batch(list, each, parallel) - verified signature in src/utils.js:51.
    const results = await _batch(
        targets,
        f => _enrichOne(f, tags, fixturesByTeam, cfg, guard),
        Number(effective('AI_ENRICH_CONCURRENCY')),
    );
    for (const r of results) { written += r?.written ?? 0; errors += r?.errors ?? 0; }
    return { fixtures: targets.length, written, errors, skipped: upcoming.length - targets.length };
}
