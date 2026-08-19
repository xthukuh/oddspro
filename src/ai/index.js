import { config } from '../config.js';
import { resolveTask } from '../db/ai-rules.js';
import * as openrouter from './openrouter.js';

// AI provider seam. ONE getProvider() swap point - directly mirrors
// src/sms/index.js, which already solved this shape. Adding a provider means
// implementing complete({ model, prompt, grounded }) -> { text, sources } and
// nothing else changes. (Gemini was retired permanently 2026-08-04; its
// provider module is deleted - historic fixture_ai_insights rows keep the
// 'gemini' provider string as provenance.)
const PROVIDERS = { openrouter };

// The adjudicators moved to src/ai/adjudicators.js (T9) and are no longer
// re-exported here - re-exporting them would form the import cycle the split
// exists to prevent (adjudicators -> harness -> index -> adjudicators).
// Adjudication callers import from './ai/adjudicators.js' directly.

export function getProvider(name) {
    const p = PROVIDERS[name];
    if (!p) throw new Error(`unknown ai provider: ${name}`);
    return p;
}

// Route one enrichment task to its provider+model. Throws on failure; callers
// fail open (the pipeline never depends on the AI being up).
// `json` asks the provider for a strict JSON reply. Every structured caller in
// this codebase (adjudicators, enrichment facts/blind/anchored) parses the
// reply as JSON, so it defaults ON; `AI_JSON_MODE=0` turns it off without a
// deploy if a future model rejects the parameter.
export async function callModel({ task, prompt, cfg = config, json = cfg.AI_JSON_MODE !== false }) {
    const { provider, model, grounded } = resolveTask(task, cfg);
    return { ...(await getProvider(provider).complete({ model, prompt, grounded, json })), provider, model, grounded };
}
