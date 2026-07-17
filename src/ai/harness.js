import { config } from '../config.js';
import { callModel as _realCallModel, getProvider as _realGetProvider } from './index.js';
import { extractJson } from '../ai-parse.js';
import {
    sanitizeReply, suspicionChecks, consensusVerdict, isCrossVendor,
    guardVerdict, recordCall,
} from '../db/ai-guard-rules.js';
import { _batch, debugLog } from '../utils.js';

// Detour B (T9): the ONE guarded path every structured AI call goes through.
// callModel stays the transport seam (provider routing, retries); this wraps
// it with the zero-trust pipeline:
//
//   guard check -> callModel -> sanitizeReply -> extractJson -> schema.parse
//   -> suspicion flags (debugLog only) -> { data, sources, ... }
//
// Nothing an AI replies is ever executed, interpolated into SQL, or trusted
// past its zod schema - the harness is the only door, and the providers
// (gemini.js / openrouter.js) stay transport-only. Callers keep their
// fail-open contract: anything unusable THROWS, and the caller records an
// 'error' verdict / counted error, exactly as before the migration.
//
// The run guard (ai-guard-rules) is opt-in per run: drainAiReviews creates
// one per drain, enrichFixtures one per sweep. Once it refuses (wall-clock
// budget spent or the breaker latched on consecutive failures), every
// remaining call in that run throws AiGuardOpen instantly instead of burning
// a 60s timeout each against a dead provider.

// Guard refusal - distinguishable from a transport/parse failure so callers
// (and the scorecard) can tell "provider broken" from "run guard said stop".
export class AiGuardOpen extends Error {
    constructor(reason) {
        super(`AI run guard open: ${reason}`);
        this.name = 'AiGuardOpen';
        this.reason = reason;
    }
}

// Ensemble label persisted as the model of a consensus verdict - reuse tags
// must reflect that a panel (not a single model) produced the verdict.
function _ensembleTag(models, minAgree) {
    return `consensus(${models.map(m => m.model).join('+')})@${minAgree}`;
}

// One structured AI call.
//   task      - resolveTask key ('adjudicate' | 'facts' | 'blind' | 'anchored')
//   prompt    - the full prompt text (built by the caller; prompt BYTES are
//               the caller's contract - the harness never edits them)
//   schema    - zod schema applied to the extracted JSON reply
//   cfg       - config object (pass an effective*Config() for live knobs)
//   guard     - optional run-guard state (ai-guard-rules#newRunGuard)
//   consensus - optional { models: [{provider,model}], minAgree, numericTol }
//               cross-vendor panel; legs run UNGROUNDED by design (only
//               Gemini grounds - a grounded consensus would be incoherent)
//   deps      - DI seam for tests: { callModel, getProvider, now }
// Returns { data, sources, provider, model, grounded, flags }.
// Throws on: guard refusal (AiGuardOpen), transport failure, no/invalid JSON,
// schema mismatch, or consensus disagreement - callers fail open.
export async function callStructured({ task, prompt, schema, cfg = config, guard = null, consensus = null, deps = {} }) {
    const callModel = deps.callModel ?? _realCallModel;
    const getProvider = deps.getProvider ?? _realGetProvider;
    const now = deps.now ?? Date.now;

    if (guard) {
        const limits = {
            maxMinutes: Number(cfg.AI_RUN_MAX_MINUTES ?? 0),
            breakerAfter: Number(cfg.AI_BREAKER_AFTER ?? 5),
        };
        const v = guardVerdict(guard, now(), limits);
        if (!v.ok) throw new AiGuardOpen(v.reason);
    }

    const t0 = now();
    try {
        const result = consensus
            ? await _consensusCall({ prompt, schema, consensus, getProvider })
            : await _singleCall({ task, prompt, schema, cfg, callModel });
        if (guard) recordCall(guard, { ms: now() - t0, transportError: false });
        if (result.flags.length) debugLog(`[ai-harness] ${task} flags: ${result.flags.join(', ')}`);
        return result;
    } catch (e) {
        // Transport AND parse failures both feed the breaker: either way the
        // provider is not answering usably and hammering it helps nobody.
        if (guard) recordCall(guard, { ms: now() - t0, transportError: true });
        throw e;
    }
}

async function _singleCall({ task, prompt, schema, cfg, callModel }) {
    const r = await callModel({ task, prompt, cfg });
    const { text, flags } = sanitizeReply(r.text);
    const data = schema.parse(extractJson(text));
    flags.push(...suspicionChecks(data, { kind: task, prompt }));
    return { data, sources: r.sources ?? [], provider: r.provider, model: r.model, grounded: r.grounded, flags };
}

// N-model cross-vendor consensus (B2/B3). Each leg fails open to null (one
// dead provider must not kill the panel); the pure consensusVerdict math
// then demands minAgree survivors agreeing on the load-bearing field, and
// the merged fields go through the SAME schema as a single reply would.
// Disagreement throws - consensus never guesses (the caller discards as
// unusable, same as any parse failure).
async function _consensusCall({ prompt, schema, consensus, getProvider }) {
    const { models = [], minAgree = 2, numericTol = 0.1 } = consensus;
    if (!isCrossVendor(models)) {
        throw new Error('consensus panel must be cross-vendor (>=2 distinct providers) - '
            + 'one vendor agreeing with itself is not consensus (see AI_CONSENSUS_MODELS)');
    }
    const flags = [];
    const legs = await _batch(models, async m => {
        try {
            // grounded deliberately absent: consensus legs run UNGROUNDED.
            const r = await getProvider(m.provider).complete({ model: m.model, prompt });
            const { text, flags: legFlags } = sanitizeReply(r.text);
            if (legFlags.length) flags.push(...legFlags.map(f => `${m.model}:${f}`));
            return schema.parse(extractJson(text));
        } catch (e) {
            debugLog(`[ai-harness] consensus leg ${m.provider}:${m.model} failed (dropped): ${e?.message ?? e}`);
            return null;
        }
    }, Math.min(models.length, 4));
    const cv = consensusVerdict(legs, { minAgree, numericTol });
    if (!cv.ok) {
        throw new Error(`consensus ${cv.reason ?? 'disagreement'} (${cv.n}/${models.length} usable legs)`);
    }
    // Re-normalize the merged fields through the schema so consumers get the
    // exact same shape a single reply would have produced.
    const data = schema.parse(cv.fields);
    flags.push(...suspicionChecks(data, { prompt }));
    return {
        data, sources: [], provider: 'consensus',
        model: _ensembleTag(models, minAgree), grounded: false, flags,
    };
}
