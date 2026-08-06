import { db } from '../db/connection.js';
import { config } from '../config.js';
import { effective, effectiveAiConfig, setOverrides } from '../settings.js';
import { maintenanceActive } from '../maintenance.js';
import { complete, enabled as openrouterEnabled } from '../ai/openrouter.js';
import { fetchCatalog, fetchEndpoints } from './catalog.js';
import { runProbes } from './qualify.js';
import { saveRow, latestRow } from './store.js';
import {
    TASK_PROFILES, isFree, modelVendor, diffCatalog, rankCandidates, buildShortlist, planSwitch,
} from './score.js';

// The seam of the self-contained model-triage add-on (design spec
// docs/dev/specs/2026-08-04-2200-openrouter-model-triage-design.md): the ONLY
// file here allowed to touch oddspro config/db/settings. catalog/score/
// qualify/store stay extraction-clean - lifting the directory out means
// rewriting this file alone.
//
// The triage cycle (weekly, LOW frequency): catalog pull + diff -> candidate
// filter -> budget-capped qualification probes (new/changed candidates only)
// -> shortlist build -> optional guard-railed auto-switch through the
// STANDARD settings write (setOverrides -> admin_audit dates it - the
// policy-regime discipline is automatic).

let running = false;
let timer = null;
let firstRun = null;

// What each task actually routes to right now, resolved from the SAME layered
// config the AI callers use (fallback chains included), so the admin card can
// never drift from reality. Kept here rather than resolveTask: that guard
// THROWS on a mis-configured blind slot, and a display path must render the
// mis-configuration instead of erroring the whole panel.
export function liveRouting() {
    const cfg = effectiveAiConfig();
    return {
        adjudicate: cfg.HOTPICK_AI_MODEL || null,
        facts: cfg.AI_FACTS_MODEL || cfg.HOTPICK_AI_MODEL || null,
        blind: cfg.AI_BLIND_MODEL || cfg.OPENROUTER_MODEL || null,
        anchored: cfg.AI_ANCHORED_MODEL || cfg.HOTPICK_AI_MODEL || null,
    };
}

const _compact = m => ({ id: m.id, name: m.name, free: isFree(m) });

// One triage pass. Best-effort background work: returns a summary, never
// throws to the scheduler. `force` (the admin "Run triage now" button)
// bypasses the enabled/due/maintenance gates but never the running slot.
export async function triageTick({ force = false } = {}) {
    if (running) return { ran: false, reason: 'already running' };
    if (!force) {
        if (!effective('TRIAGE_ENABLED')) return { ran: false, reason: 'disabled' };
        // Quiesce during a declared maintenance window like the geo tick -
        // probes bill real calls, and triage is pure catch-up work.
        if (maintenanceActive()) return { ran: false, reason: 'maintenance' };
        const last = await latestRow(db, 'shortlist');
        const intervalMs = effective('TRIAGE_INTERVAL_HOURS') * 3_600_000;
        if (last && Date.now() - new Date(last.created_at).getTime() < intervalMs) {
            return { ran: false, reason: 'not due' };
        }
    }
    running = true;
    try {
        const baseUrl = config.OPENROUTER_URL;
        const models = await fetchCatalog({ baseUrl });
        // An empty reply is an API hiccup, not a catalog of zero models -
        // saving it would fake a mass delisting in the next diff.
        if (!models.length) return { ran: false, reason: 'empty catalog reply' };

        const prevSnap = await latestRow(db, 'snapshot');
        const events = diffCatalog(prevSnap?.payload?.models ?? [], models);
        const routing = liveRouting();

        // A delisted model that our LIVE routing still points at = LOUD alert
        // (the exact free-tier failure mode the 2026-08-04 research observed).
        const liveIds = new Set(Object.values(routing).filter(Boolean));
        for (const lost of events.delisted.filter(m => liveIds.has(m.id))) {
            console.error(`[triage] *** LIVE MODEL DELISTED FROM OPENROUTER: ${lost.id} - `
                + 'the routing that uses it will start failing; adopt a replacement in Admin -> Models. ***');
        }
        await saveRow(db, 'snapshot', {
            fetched_at: new Date().toISOString(),
            count: models.length,
            models,
        });

        // Qualification: NEW or CHANGED candidates only, budget-capped (3
        // billed probe calls per candidate). Existing verdicts are reused.
        const tax = effective('TRIAGE_FREE_FLAKINESS_TAX');
        const prevQuals = (await latestRow(db, 'qualification'))?.payload?.quals ?? {};
        const changed = new Set([...events.added.map(m => m.id), ...events.price_changed.map(p => p.id)]);
        const targets = [];
        for (const task of Object.keys(TASK_PROFILES)) {
            const blindVendorBan = task === 'blind' && routing.anchored ? modelVendor(routing.anchored) : null;
            for (const { model } of rankCandidates(models, task, { flakinessTax: tax, blindVendorBan }).slice(0, 6)) {
                if (targets.includes(model.id)) continue;
                if (prevQuals[model.id] && !changed.has(model.id)) continue;
                targets.push(model.id);
            }
        }
        const budget = effective('TRIAGE_PROBE_BUDGET');
        const probeList = openrouterEnabled() ? targets.slice(0, Math.floor(budget / 3)) : [];
        const quals = { ...prevQuals };
        for (const id of probeList) {
            const qual = await runProbes(id, { call: ({ model, prompt }) => complete({ model, prompt }) });
            const ep = await fetchEndpoints(id, { baseUrl }); // free; null = unknown
            quals[id] = { ...qual, uptime: ep?.uptime ?? null };
        }
        if (probeList.length) {
            await saveRow(db, 'qualification', {
                ran_at: new Date().toISOString(),
                probed: probeList,
                quals,
            });
        }

        const shortlist = buildShortlist({ models, quals, routing, opts: { flakinessTax: tax } });

        // Auto-switch (OFF by default): ONE task per tick, fully-qualified
        // primary only, vendor guardrails - all decided in pure planSwitch.
        // The write goes through the standard settings path, so the dated
        // admin_audit old->new row and the live re-read happen exactly as if
        // an admin had edited the key by hand.
        let switched = null;
        if (effective('TRIAGE_AUTO_SWITCH')) {
            const sw = planSwitch({ shortlist, routing, quals });
            if (sw) {
                await setOverrides([[sw.settingKey, sw.to]], null);
                console.warn(`[triage] *** AUTO-SWITCH: ${sw.task} ${sw.from ?? '(unset)'} -> ${sw.to} `
                    + `(${sw.reason}; ${sw.settingKey} written via settings - audited) ***`);
                switched = sw;
            }
        }

        await saveRow(db, 'shortlist', {
            generated_at: new Date().toISOString(),
            events: {
                added: events.added.map(_compact),
                delisted: events.delisted.map(_compact),
                price_changed: events.price_changed,
            },
            routing: switched ? liveRouting() : routing,
            switched,
            tasks: shortlist.tasks,
        });
        const summary = {
            ran: true,
            models: models.length,
            events: { added: events.added.length, delisted: events.delisted.length, price_changed: events.price_changed.length },
            probed: probeList.length,
            switched,
        };
        console.debug(`[triage] pass done - ${summary.models} models, +${summary.events.added}/-${summary.events.delisted} `
            + `(${summary.events.price_changed} repriced), ${summary.probed} candidate(s) probed`
            + (switched ? `, SWITCHED ${switched.task} -> ${switched.to}` : ''));
        return summary;
    } catch (e) {
        console.error('[triage] pass failed:', e?.message ?? e);
        return { ran: false, reason: String(e?.message ?? e) };
    } finally {
        running = false;
    }
}

// Admin GET /api/admin/triage payload: knob state + live routing + the newest
// persisted shortlist (null until the first pass runs).
export async function getTriageState() {
    const last = await latestRow(db, 'shortlist');
    return {
        status: {
            enabled: Boolean(effective('TRIAGE_ENABLED')),
            auto_switch: Boolean(effective('TRIAGE_AUTO_SWITCH')),
            interval_hours: effective('TRIAGE_INTERVAL_HOURS'),
            probe_budget: effective('TRIAGE_PROBE_BUDGET'),
            openrouter_key: openrouterEnabled(),
            running,
            last_run_at: last?.created_at ?? null,
        },
        routing: liveRouting(),
        shortlist: last?.payload ?? null,
    };
}

// Admin "Run triage now": fire-and-forget on the module's own single slot
// (a second click while one runs answers started:false -> the route 409s).
export function runTriageNow() {
    if (running) return { started: false };
    triageTick({ force: true }); // triageTick never rejects
    return { started: true };
}

// Weekly-by-default background cadence via an HOURLY due-check (the tick
// itself gates on enabled/maintenance/last-run age), so every ai-triage knob
// is live - no restart - and a mid-week server restart never re-runs early.
// unref'd like every other in-process scheduler.
export function startTriageScheduler() {
    if (timer) return false;
    firstRun = setTimeout(() => { triageTick(); }, 90_000);
    firstRun.unref?.();
    timer = setInterval(() => { triageTick(); }, 3_600_000);
    timer.unref?.();
    console.debug('[triage] scheduler on - hourly due-check, '
        + `${effective('TRIAGE_ENABLED') ? `every ${effective('TRIAGE_INTERVAL_HOURS')}h` : 'currently disabled (TRIAGE_ENABLED off)'}`);
    return true;
}

export function stopTriageScheduler() {
    if (firstRun) { clearTimeout(firstRun); firstRun = null; }
    if (timer) { clearInterval(timer); timer = null; }
}
