// Pure data-notice rules (zero DB/config imports so tests skip .env, and so
// the web app can import this module verbatim - the magic-rules idiom, one
// definition of "is this day damaged" on both sides of the wire).
//
// The detector deliberately reads the COLLECTOR'S OWN VERDICT, never the shape
// of the data. A row-count heuristic was measured against the live warehouse
// and refuted: it fires on five healthy days in a 45-day window, because the
// capture regime shifted on 2026-08-05 and thin midweek slates are normal
// football. See docs/dev/specs/2026-08-20-2114-data-notices.md section 2.

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

const sortedRuns = runs => (Array.isArray(runs) ? runs : [])
    .filter(r => Number.isFinite(finishedMs(r)))
    .sort((a, b) => finishedMs(a) - finishedMs(b));

// A stretch of wall-clock time with no finished run at all. The threshold
// counts MISSING RUNS, not missing odds: a quiet-slate idle skip still runs
// the pass and still records an `ok` row, so an idle night is never a gap.
export function runGapSpans(runs, { maxGapMinutes = 90 } = {}) {
    const list = sortedRuns(runs);
    const out = [];
    for (let i = 1; i < list.length; i++) {
        const prev = finishedMs(list[i - 1]);
        const next = finishedMs(list[i]);
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

// Dates a `partial` run covered, merged when consecutive partial runs overlap.
export function partialSpans(runs) {
    const out = [];
    for (const r of sortedRuns(runs)) {
        if (r?.verdict !== 'partial') continue;
        const dates = (Array.isArray(r.dates) ? r.dates : []).filter(Boolean).sort();
        if (!dates.length) continue;
        const steps = (Array.isArray(r.step_failures) ? r.step_failures : [])
            .map(f => f?.step).filter(Boolean);
        const span = { date_from: dates[0], date_to: dates[dates.length - 1], steps };
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
export function detectNotices(runs, { maxGapMinutes = 90 } = {}) {
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
