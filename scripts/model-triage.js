// Free-model discovery, triage, probing and scoring (2026-08-28).
//
// Read-only against the warehouse: it never writes a setting, never touches
// the prediction ledger, and its ONLY side effect is the OpenRouter calls it
// makes. Point it at the free catalog, it probes every candidate against the
// five acceptance criteria in src/db/model-triage-rules.js and prints a
// ranked table plus a per-role recommendation.
//
// Usage, from the app root:
//   node scripts/model-triage.js                    # probe every free model
//   node scripts/model-triage.js --runs 3           # 3 probes each (default 2)
//   node scripts/model-triage.js --only a,b         # just these slugs
//   node scripts/model-triage.js --min-output 8000  # drop small ceilings
//   node scripts/model-triage.js --json out.json    # also write the raw report
//
// Why probe at all rather than read the catalog metadata: the catalog says
// what a model COULD do, not what it does. The failures that put 8
// reasoning-only and 6 no-choices errors into the live stderr log were all
// invisible in metadata - the models were listed, priced free, with ample
// context, and still returned no usable content.
//
// The prompt is deliberately a real oddspro task (a football market judged
// from odds), not a toy. A model that will not answer THIS is useless here
// however well it scores on anything else, which is what the `no_refusal`
// criterion measures.
import { writeFileSync } from 'node:fs';
import { config } from '../src/config.js';
import { complete } from '../src/ai/openrouter.js';
import {
    catalogCandidates, probeVerdict, scoreModel, rankModels, recommendForRole, modelVendor,
} from '../src/db/model-triage-rules.js';

const args = process.argv.slice(2);
const argVal = (f, d = null) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const RUNS = Math.max(1, Number(argVal('--runs', 2)) || 2);
const ONLY = (argVal('--only') ?? '').split(',').map(s => s.trim()).filter(Boolean);
const MIN_OUTPUT = Number(argVal('--min-output', 0)) || 0;
const MIN_CONTEXT = Number(argVal('--min-context', 0)) || 0;
const JSON_OUT = argVal('--json');
const TIMEOUT_MS = Number(argVal('--timeout', 60_000)) || 60_000;
// The adjudicator runs GROUNDED (web search), and a model that answers fine
// ungrounded can still fail once the web plugin's context is bolted on - so a
// pick for that role must be probed the way it will actually be called.
// Grounding bills the plugin (about $0.001/request) even on a free model,
// which is why it is opt-in rather than the default.
const GROUNDED = args.includes('--grounded');

// One representative structured task from this warehouse's own domain. Kept
// small so a probe is cheap, and shaped exactly like the real callers: strict
// JSON out, a fixed key set, a judgement rather than a lookup.
const PROBE_PROMPT = [
    'A football match has these bookmaker decimal odds for total goals:',
    'Over 2.5 = 1.80, Under 2.5 = 2.05.',
    'The two teams have averaged 3.1 combined goals across their last 6 matches each.',
    '',
    'Judge whether the Over 2.5 price offers value. Reply with ONLY a JSON object,',
    'no prose and no code fence, with exactly these keys:',
    '  "verdict": one of "value", "no_value", "unclear"',
    '  "implied_probability": the number implied by the Over 2.5 price, 0 to 1',
    '  "reason": one short sentence',
].join('\n');

const REQUIRED_KEYS = ['verdict', 'implied_probability', 'reason'];

function die(msg) { console.error(`[triage] ERROR: ${msg}`); process.exit(1); }

// Bound every probe: a hung endpoint must cost one timeout, never the run.
function withTimeout(promise, ms, label) {
    let t;
    const timer = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`timeout after ${ms}ms (${label})`)), ms); });
    return Promise.race([promise, timer]).finally(() => clearTimeout(t));
}

async function probeOnce(model) {
    const t0 = Date.now();
    try {
        const { text } = await withTimeout(
            complete({ model, prompt: PROBE_PROMPT, grounded: GROUNDED, json: true, maxTokens: 16_000, reasoningEffort: 'low' }),
            TIMEOUT_MS, model,
        );
        return probeVerdict({ ok: true, text, ms: Date.now() - t0, requiredKeys: REQUIRED_KEYS });
    } catch (e) {
        return probeVerdict({
            ok: false,
            error: e?.message ?? String(e),
            replyReason: e?.replyReason ?? null,
            ms: Date.now() - t0,
            requiredKeys: REQUIRED_KEYS,
        });
    }
}

async function main() {
    if (!config.OPENROUTER_API_KEY) die('OPENROUTER_API_KEY is not set - nothing to probe.');

    const res = await fetch('https://openrouter.ai/api/v1/models');
    if (!res.ok) die(`catalog fetch failed: HTTP ${res.status}`);
    const { data } = await res.json();

    let candidates = catalogCandidates(data, { minContext: MIN_CONTEXT, minOutput: MIN_OUTPUT });
    if (ONLY.length) candidates = candidates.filter(c => ONLY.includes(c.id));
    if (!candidates.length) die('no free candidates matched the filters.');

    console.log(`[triage] ${candidates.length} free candidate(s), ${RUNS} probe(s) each, timeout ${TIMEOUT_MS}ms`
        + `, ${GROUNDED ? 'GROUNDED (web plugin billed)' : 'ungrounded'}\n`);

    const scored = [];
    for (const c of candidates) {
        const probes = [];
        for (let i = 0; i < RUNS; i++) probes.push(await probeOnce(c.id));
        const s = scoreModel(probes);
        scored.push({ ...c, ...s, probes });
        const mark = s.accepted ? 'PASS' : 'fail';
        const failed = probes.find(p => !p.pass);
        console.log(`  ${mark}  ${c.id.padEnd(48)} score=${s.score.toFixed(3)} p50=${s.medianMs}ms`
            + (s.accepted ? '' : `  <- ${failed?.reason ?? 'unknown'}`));
    }

    const ranked = rankModels(scored);
    console.log('\n[triage] ranked (accepted first):');
    console.log('  rank  model                                            score  pass   p50      ctx/out');
    ranked.forEach((m, i) => {
        console.log(`  ${String(i + 1).padStart(4)}  ${m.id.padEnd(48)} ${m.score.toFixed(3)}  `
            + `${(m.passRate * 100).toFixed(0).padStart(3)}%  ${String(m.medianMs).padStart(6)}ms  ${m.context}/${m.maxOutput}`);
    });

    // Per-role picks. The blind reasoner must not share a vendor with the
    // anchored model (src/db/ai-rules.js#blindModelRejection), so anchored is
    // resolved first and blind then excludes whatever vendor won.
    const anchored = recommendForRole(ranked);
    const blind = recommendForRole(ranked, { excludeVendors: anchored ? [modelVendor(anchored.id), 'google'] : ['google'] });
    const adjudicator = recommendForRole(ranked);
    console.log('\n[triage] role recommendations:');
    console.log(`  AI_ANCHORED_MODEL / AI_FACTS_MODEL : ${anchored?.id ?? '(none accepted)'}`);
    console.log(`  AI_BLIND_MODEL (different vendor)  : ${blind?.id ?? '(none accepted)'}`);
    console.log(`  HOTPICK_AI_MODEL (adjudicator)     : ${adjudicator?.id ?? '(none accepted)'}`);
    console.log('\n[triage] read-only: nothing was written. Apply picks via Admin -> Settings.');

    if (JSON_OUT) {
        writeFileSync(JSON_OUT, JSON.stringify({ generated_at: new Date().toISOString(), ranked }, null, 2));
        console.log(`[triage] raw report -> ${JSON_OUT}`);
    }
}

main().catch(e => die(e?.message ?? String(e)));
