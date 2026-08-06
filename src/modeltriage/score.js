// PURE model-triage ranking rules (ZERO imports, offline-tested - the
// src/db/*-rules.js contract applied to the self-contained src/modeltriage/
// add-on; design spec docs/dev/specs/2026-08-04-2200-openrouter-model-triage-
// design.md). Everything here works on the NORMALIZED model shape catalog.js
// produces ({ id, name, vendor, created, context, pricing, structured, tools,
// free, aa }) and the qualification shape qualify.js produces - no HTTP, no
// config, no DB, so the whole decision surface is assertable offline and the
// directory lifts out as a standalone tool.

// Per-task requirement profiles. settingKey is the LIVE routing knob a switch/
// adopt writes through the standard settings PUT (admin_audit dates it);
// 'bulk' is advisory-only - a cheap-workhorse shortlist with no live consumer
// yet, so it can never be switched. Token profiles approximate each task's
// real prompt/reply mix and price the $-per-call blend.
export const TASK_PROFILES = {
    adjudicate: { key: 'adjudicate', label: 'Adjudicator (hot/tip verdicts)', settingKey: 'HOTPICK_AI_MODEL', minContext: 16000, needsStructured: true, needsWeb: true, tokensIn: 2500, tokensOut: 600 },
    facts: { key: 'facts', label: 'Facts extraction (grounded)', settingKey: 'AI_FACTS_MODEL', minContext: 16000, needsStructured: true, needsWeb: true, tokensIn: 1500, tokensOut: 500 },
    blind: { key: 'blind', label: 'Blind reasoner', settingKey: 'AI_BLIND_MODEL', minContext: 8000, needsStructured: true, needsWeb: false, tokensIn: 1500, tokensOut: 400 },
    anchored: { key: 'anchored', label: 'Anchored reasoner', settingKey: 'AI_ANCHORED_MODEL', minContext: 8000, needsStructured: true, needsWeb: false, tokensIn: 1500, tokensOut: 400 },
    bulk: { key: 'bulk', label: 'Bulk / cheap workhorse (advisory)', settingKey: null, minContext: 8000, needsStructured: false, needsWeb: false, tokensIn: 1000, tokensOut: 300 },
};

// Same 4-line duplication as ai-rules.js#modelVendor - sanctioned zero-import
// precedent (a pure module never imports a zod-importing one for 4 lines).
export function modelVendor(id) {
    const s = String(id ?? '');
    const slash = s.indexOf('/');
    return (slash > 0 ? s.slice(0, slash) : s).toLowerCase();
}

// Google-family ban for the blind slot (mirrors resolveTask's guard): the
// blind reasoner exists to check the anchored one, so it must never be the
// same lab - and the historical anchored/facts lineage is Google-adjacent.
const GOOGLE_RE = /gemini|google|gemma/i;

// :free suffix, an explicit free flag, or an all-zero price card.
export function isFree(m) {
    if (!m) return false;
    if (m.free === true || String(m.id ?? '').endsWith(':free')) return true;
    const p = m.pricing ?? {};
    if (p.prompt == null && p.completion == null) return false;
    return Number(p.prompt ?? 0) === 0 && Number(p.completion ?? 0) === 0;
}

// USD per call at a task's token profile. OpenRouter pricing is per TOKEN.
export function blendedCostPerCall(pricing, profile) {
    const p = pricing ?? {};
    return Number(p.prompt ?? 0) * (profile?.tokensIn ?? 0)
        + Number(p.completion ?? 0) * (profile?.tokensOut ?? 0);
}

// Capability proxy: the Artificial-Analysis intelligence index (0-100) the
// models API carries, normalized 0..1. Absent -> a CONSERVATIVE default (an
// unbenchmarked model must earn its place through probes, not assumption).
export function capabilityOf(m, fallback = 0.35) {
    const aa = m?.aa;
    if (aa == null || !Number.isFinite(Number(aa))) return fallback;
    return Math.min(1, Math.max(0, Number(aa) / 100));
}

// Value per cost. A :free model costs daily-cap risk, not $0 - the score
// charges it the flakiness tax (a capability fraction) instead of a dollar
// cost. Paid models divide capability by blended cost, scaled so a 1-cent
// call halves the value (x100: 0.01 USD -> divisor 2).
export function valueScore(m, profile, { flakinessTax = 0.15 } = {}) {
    const cap = capabilityOf(m);
    if (isFree(m)) return cap * (1 - flakinessTax);
    return cap / (1 + blendedCostPerCall(m.pricing, profile) * 100);
}

// Hard requirements per task profile -> { ok, reasons[] }. An unknown context
// fails the floor (conservative: hard requirements are proven, not assumed).
export function hardFilter(m, profile, { blindVendorBan = null } = {}) {
    const reasons = [];
    const ctx = Number(m?.context ?? 0);
    if (!(ctx >= (profile?.minContext ?? 0))) reasons.push(`context ${m?.context ?? 'unknown'} < ${profile?.minContext}`);
    if (profile?.needsStructured && !m?.structured) reasons.push('no structured-output support');
    if (profile?.needsWeb && !m?.tools) reasons.push('no tool/web composability');
    if (profile?.key === 'blind') {
        if (GOOGLE_RE.test(String(m?.id ?? ''))) reasons.push('google-family model (blind stays vendor-independent)');
        if (blindVendorBan && modelVendor(m?.id) === blindVendorBan) {
            reasons.push(`shares the anchored vendor (${blindVendorBan})`);
        }
    }
    return { ok: reasons.length === 0, reasons };
}

// Catalog diff between two normalized snapshots -> the admin events feed.
// price_changed compares the prompt/completion card only (web_search pricing
// moves often and is not what routing decisions hinge on).
export function diffCatalog(prev, next) {
    const prevBy = new Map((prev ?? []).map(m => [m.id, m]));
    const nextBy = new Map((next ?? []).map(m => [m.id, m]));
    const added = (next ?? []).filter(m => !prevBy.has(m.id));
    const delisted = (prev ?? []).filter(m => !nextBy.has(m.id));
    const price_changed = [];
    for (const m of next ?? []) {
        const was = prevBy.get(m.id);
        if (!was) continue;
        const a = was.pricing ?? {}, b = m.pricing ?? {};
        if (Number(a.prompt ?? 0) !== Number(b.prompt ?? 0)
            || Number(a.completion ?? 0) !== Number(b.completion ?? 0)) {
            price_changed.push({
                id: m.id,
                before: { prompt: a.prompt ?? null, completion: a.completion ?? null },
                after: { prompt: b.prompt ?? null, completion: b.completion ?? null },
            });
        }
    }
    return { added, delisted, price_changed };
}

// Endpoint health gate (uptime_last_30m from the endpoints API). Unknown
// uptime PASSES - absence of evidence is not a failed endpoint, and the probe
// verdicts are the gate that actually bites.
export function uptimeOk(uptime, floor = 90) {
    if (uptime == null) return true;
    return Number(uptime) >= floor;
}

// Human-readable pros/cons for the admin card. Deterministic strings so the
// shortlist payload is stable across reruns of identical inputs.
export function prosCons(m, profile, qual) {
    const pros = [];
    const cons = [];
    const cost = blendedCostPerCall(m?.pricing, profile);
    if (isFree(m)) {
        pros.push('Free tier (no per-call cost)');
        cons.push('Free tier: daily-cap risk and endpoint flakiness');
    } else if (cost > 0 && cost < 0.001) {
        pros.push(`Cheap (~$${cost.toFixed(5)}/call at this task's token profile)`);
    } else if (cost >= 0.01) {
        cons.push(`Expensive (~$${cost.toFixed(3)}/call at this task's token profile)`);
    }
    const ctx = Number(m?.context ?? 0);
    if (ctx >= 100000) pros.push(`Large context (${Math.round(ctx / 1000)}k tokens)`);
    else if (ctx > 0 && ctx < 32000) cons.push(`Small context (${Math.round(ctx / 1000)}k tokens)`);
    if (m?.structured) pros.push('Enforces JSON replies (structured outputs)');
    else cons.push('No structured-output enforcement');
    if (m?.aa != null) {
        if (m.aa >= 60) pros.push(`Strong benchmark (AA intelligence index ${m.aa})`);
        else cons.push(`Modest benchmark (AA intelligence index ${m.aa})`);
    } else {
        cons.push('No benchmark data (conservative capability assumed)');
    }
    if (qual) {
        const failed = Object.entries(qual.probes ?? {}).filter(([, r]) => r && r.pass === false).map(([k]) => k);
        if ((qual.passes ?? 0) >= 3) pros.push('Passed all qualification probes');
        if (failed.length) cons.push(`Failed probes: ${failed.join(', ')}`);
        if (qual.uptime != null) {
            if (Number(qual.uptime) >= 99) pros.push(`High uptime (${qual.uptime}% last 30m)`);
            else if (!uptimeOk(qual.uptime)) cons.push(`Low uptime (${qual.uptime}% last 30m)`);
        }
    } else {
        cons.push('Not yet probe-qualified');
    }
    return { pros, cons };
}

// Hard-filter then sort by value score desc -> [{ model, score }].
export function rankCandidates(models, task, opts = {}) {
    const profile = TASK_PROFILES[task];
    if (!profile) return [];
    return (models ?? [])
        .filter(m => hardFilter(m, profile, opts).ok)
        .map(model => ({ model, score: valueScore(model, profile, opts) }))
        .sort((a, b) => b.score - a.score);
}

// The persisted shortlist payload: per task, the ranked candidate cards plus
// a PRIMARY/FALLBACK recommendation. A candidate becomes primary only with a
// fully-passed qualification AND a healthy endpoint - an unqualified top
// scorer is SHOWN (it explains what the next probe run will spend budget on)
// but never recommended. The blind task bans the LIVE anchored vendor.
export function buildShortlist({ models, quals = {}, routing = {}, opts = {} }) {
    const { minPasses = 3, uptimeFloor = 90, maxCandidates = 6 } = opts;
    const tasks = {};
    for (const task of Object.keys(TASK_PROFILES)) {
        const profile = TASK_PROFILES[task];
        const blindVendorBan = task === 'blind' && routing.anchored ? modelVendor(routing.anchored) : null;
        const ranked = rankCandidates(models, task, { ...opts, blindVendorBan }).slice(0, maxCandidates);
        const candidates = ranked.map(({ model, score }) => {
            const qual = quals[model.id] ?? null;
            const { pros, cons } = prosCons(model, profile, qual);
            return {
                id: model.id, name: model.name, vendor: model.vendor,
                context: model.context, pricing: model.pricing, free: isFree(model), aa: model.aa,
                score, qual, uptime: qual?.uptime ?? null, pros, cons,
            };
        });
        const qualified = candidates.filter(c => c.qual && (c.qual.passes ?? 0) >= minPasses && uptimeOk(c.uptime, uptimeFloor));
        tasks[task] = {
            label: profile.label,
            settingKey: profile.settingKey,
            candidates,
            primary: qualified[0]?.id ?? null,
            fallback: qualified[1]?.id ?? null,
        };
    }
    return { tasks };
}

// Auto-switch guardrails, all in one pure decision: at most ONE task switch
// per tick (profile order = spec priority), only to a fully-qualified
// primary, and never a switch that leaves blind and anchored on the same
// vendor. Returns { task, settingKey, from, to, reason } or null.
export function planSwitch({ shortlist, routing = {}, quals = {}, opts = {} }) {
    const { minPasses = 3 } = opts;
    for (const task of Object.keys(TASK_PROFILES)) {
        const profile = TASK_PROFILES[task];
        if (!profile.settingKey) continue; // advisory-only (bulk)
        const t = shortlist?.tasks?.[task];
        const to = t?.primary;
        if (!to || to === routing[task]) continue;
        const qual = quals[to];
        if (!qual || (qual.passes ?? 0) < minPasses) continue;
        // Post-switch vendor guard: blind and anchored must stay different labs.
        const post = { ...routing, [task]: to };
        if (post.blind && post.anchored && modelVendor(post.blind) === modelVendor(post.anchored)) continue;
        if (task === 'blind' && GOOGLE_RE.test(String(to))) continue;
        return {
            task,
            settingKey: profile.settingKey,
            from: routing[task] ?? null,
            to,
            reason: `shortlist primary with ${qual.passes}/3 probe passes`,
        };
    }
    return null;
}
