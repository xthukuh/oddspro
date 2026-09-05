// Pure data-notice rules (no DB/config imports, so tests skip .env, and so
// the web app can import this module verbatim - the magic-rules idiom, one
// definition of "is this day damaged" on both sides of the wire). The ONLY
// import is DATA_BEARING_STEP_RE from the equally pure, zero-import
// src/db/auto-rules.js - a sanctioned cross-pure import (magic-rules.js does
// the same over perf-rules.js), not a violation: browser safety and offline
// testability both come from every module in the chain being import-free of
// DB/config, not from this file having no imports at all.
//
// The detector deliberately reads the COLLECTOR'S OWN VERDICT, never the shape
// of the data. A row-count heuristic was measured against the live warehouse
// and refuted: it fires on five healthy days in a 45-day window, because the
// capture regime shifted on 2026-08-05 and thin midweek slates are normal
// football. See docs/dev/specs/2026-08-20-2114-data-notices.md section 2.
import { DATA_BEARING_STEP_RE } from './auto-rules.js';

export const SEVERITIES = ['degraded', 'outage'];

const RANK = { degraded: 1, outage: 2 };

const COPY = {
    odds_outage: {
        title: 'No odds collected',
        note: 'Collection was down. Odds for these games were never captured.',
    },
    odds_degraded: {
        title: 'Some odds missing',
        note: 'Collection ran but did not finish. Some games have no odds.',
    },
};

export function severityRank(severity) {
    return RANK[severity] ?? 0;
}

// An instant read as its EAT (+03:00) calendar day. The warehouse stores EAT
// wall-clock and the SQL session is pinned to +03:00, so every day boundary in
// this module must be EAT too, never the host's local timezone.
export function eatDay(value) {
    if (value == null) return null;
    const ms = value instanceof Date ? value.getTime() : (typeof value === 'number' ? value : Date.parse(String(value)));
    if (!Number.isFinite(ms)) return null;
    return new Date(ms + 3 * 3_600_000).toISOString().slice(0, 10);
}

const dayMs = day => Date.parse(`${day}T00:00:00Z`);

export function datesBetween(fromDay, toDay) {
    const a = dayMs(fromDay);
    const b = dayMs(toDay);
    if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return [];
    const out = [];
    for (let t = a; t <= b; t += 86_400_000) out.push(new Date(t).toISOString().slice(0, 10));
    return out;
}

const finishedMs = r => Date.parse(String(r?.finished_at ?? ''));
// When a run began. A row without a usable started_at (pre-ledger fixtures,
// older test doubles) is read as instantaneous: started when it finished.
const startedMs = r => {
    const ms = Date.parse(String(r?.started_at ?? ''));
    return Number.isFinite(ms) ? Math.min(ms, finishedMs(r)) : finishedMs(r);
};

const sortedRuns = runs => (Array.isArray(runs) ? runs : [])
    .filter(r => Number.isFinite(finishedMs(r)))
    .sort((a, b) => finishedMs(a) - finishedMs(b));

// A stretch of wall-clock time with no run finished OR in progress. The
// threshold counts MISSING RUNS, not missing odds: a quiet-slate idle skip
// still runs the pass and still records an `ok` row, so an idle night is
// never a gap.
//
// FIX (2026-09-05): the gap is measured from the previous run's finish to the
// NEXT run's start, never finish to finish. The full sweep holds the single
// job slot for 2.5-7h on the live host and captures every provider's odds in
// its first minutes; measured finish-to-finish, every sweep morning read as a
// multi-hour outage (eleven false "No odds collected" proposals, 2026-08-26
// to 2026-09-05, served to visitors as UNCONFIRMED). A run that is running
// is the collector being busy, which is the opposite of the collector being
// down.
export function runGapSpans(runs, opts) {
    const { maxGapMinutes = 90 } = opts ?? {};
    const list = sortedRuns(runs);
    const out = [];
    for (let i = 1; i < list.length; i++) {
        const prev = finishedMs(list[i - 1]);
        const next = startedMs(list[i]);
        const gap = Math.round((next - prev) / 60_000);
        if (gap <= maxGapMinutes) continue;
        out.push({
            from_at: new Date(prev).toISOString(),
            to_at: new Date(next).toISOString(),
            gap_minutes: gap,
            date_from: eatDay(prev),
            date_to: eatDay(next),
        });
    }
    return out;
}

const TRAILING_DATE_RE = /(\d{4}-\d{2}-\d{2})$/;

// Dates a `partial` run's DATA-BEARING failures actually affected, merged
// when consecutive partial runs propose an identical span.
//
// `summarizeSteps` returns 'partial' when ANY guarded step fails, and the
// full sweep guards roughly fifteen steps - standings/history/prematch/
// predictions/hotpicks/enrich among them - most of which never touch odds
// and can fail on an unrelated API-Football hiccup. Reporting the run's WHOLE
// `dates` array (today..today+N for a full sweep) on ANY such failure used to
// claim odds were missing for future days that were collected perfectly -
// a confident lie about the exact thing this feature exists to report.
//
// Only DATA_BEARING_STEP_RE failures (results/betpawa odds/betika odds, see
// src/db/auto-rules.js) may produce a span, and the span is derived from
// THOSE steps' own date labels ('betpawa odds 2026-08-20'), never the run's
// full scope: min..max of the dates named on the failed data-bearing steps.
// A bare label with no trailing date (the light pass's plain 'results') falls
// back to the run's own `dates` array, since that is the only scope
// information available for it. A run whose data-bearing failures list is
// empty (every failure was a non-odds step) produces NO span at all.
export function partialSpans(runs) {
    const out = [];
    for (const r of sortedRuns(runs)) {
        if (r?.verdict !== 'partial') continue;
        const steps = (Array.isArray(r.step_failures) ? r.step_failures : [])
            .map(f => f?.step).filter(Boolean)
            .filter(step => DATA_BEARING_STEP_RE.test(step));
        if (!steps.length) continue;
        const named = steps
            .map(step => TRAILING_DATE_RE.exec(step)?.[1])
            .filter(Boolean)
            .sort();
        let dateFrom, dateTo;
        if (named.length) {
            dateFrom = named[0];
            dateTo = named[named.length - 1];
        } else {
            const dates = (Array.isArray(r.dates) ? r.dates : []).filter(Boolean).sort();
            if (!dates.length) continue;
            dateFrom = dates[0];
            dateTo = dates[dates.length - 1];
        }
        const span = { date_from: dateFrom, date_to: dateTo, steps };
        const last = out[out.length - 1];
        if (last && last.date_from === span.date_from && last.date_to === span.date_to) {
            last.steps = [...new Set([...last.steps, ...span.steps])];
            continue;
        }
        out.push(span);
    }
    return out;
}

// Proposals only. Nothing here decides what is SHOWN; that is the admin's
// approve/dismiss call, and an unconfirmed proposal is shown meanwhile.
export function detectNotices(runs, opts) {
    const { maxGapMinutes = 90 } = opts ?? {};
    const out = [];
    for (const g of runGapSpans(runs, { maxGapMinutes })) {
        out.push({
            kind: 'odds_outage',
            severity: 'outage',
            date_from: g.date_from,
            date_to: g.date_to,
            ...COPY.odds_outage,
            evidence: { from_at: g.from_at, to_at: g.to_at, gap_minutes: g.gap_minutes },
        });
    }
    for (const p of partialSpans(runs)) {
        out.push({
            kind: 'odds_degraded',
            severity: 'degraded',
            date_from: p.date_from,
            date_to: p.date_to,
            ...COPY.odds_degraded,
            evidence: { steps: p.steps },
        });
    }
    return out;
}

export function noticesForDate(notices, day) {
    if (!day) return [];
    return (Array.isArray(notices) ? notices : [])
        .filter(n => n?.status !== 'dismissed')
        .filter(n => n?.date_from <= day && day <= n?.date_to);
}

export function coverageStatus(notices) {
    const list = Array.isArray(notices) ? notices : [];
    let rank = 0;
    for (const n of list) rank = Math.max(rank, severityRank(n?.severity));
    return rank === 2 ? 'outage' : (rank === 1 ? 'degraded' : 'ok');
}

// The hedge an unreviewed proposal carries. It is a prefix rather than a
// suppression on purpose: the warning must work while the owner is away.
export function noticeLabel(notice) {
    const title = notice?.title ?? '';
    return notice?.status === 'unconfirmed' ? `UNCONFIRMED - ${title}` : title;
}

export function coveragePayload(notices, day) {
    const hits = noticesForDate(notices, day);
    return {
        status: coverageStatus(hits),
        confirmed: hits.every(n => n?.status === 'approved'),
        notices: hits,
    };
}
