// Guest-vs-normal access rules (v1.1.0 Phase 8, GUEST_PREMIUM extension).
// Pure, zero imports - offline-testable. The server is authoritative:
// src/server.js computes the access descriptor from the (optional) session
// user and src/db/records.js applies it - the web client's guest date clamp
// / detail hide is UX sugar over the same rules, never the enforcement.
//
// Tiers: a missing user = guest (past/today only, redacted detail unless
// GUEST_PREMIUM is on); any signed-in user = full (future dates + tip
// internals). AUTH_ENABLED=0 installs and API_TOKEN/ADMIN_TOKEN machine
// bearers never reach these rules (access stays null = the legacy
// everyone-sees-everything behavior).
//
// GUEST_PREMIUM (admin-editable, settings group auth-policy, default off):
// when the caller passes opts.guestPremium truthy, a signed-out visitor gets
// canFuture/fullDetail like a signed-in user - the SAME dates and tip
// reasoning, no redaction. The role STAYS 'guest' regardless: account-bound
// features (saved/shareable slips, prefs sync, admin) gate on role/session
// elsewhere and must never open just because this detail flag is on.

// Access descriptor for a session user (or null/undefined = guest).
// role: 'guest' | 'normal' | 'admin'; canFuture: may load dates after today;
// fullDetail: receives tip_breakdown / AI reasoning / exact confidence.
// opts.guestPremium: GUEST_PREMIUM setting, only consulted for guests.
export function accessFromUser(user, opts = {}) {
    if (!user) {
        const premium = Boolean(opts.guestPremium);
        return { role: 'guest', canFuture: premium, fullDetail: premium };
    }
    return { role: user.role === 'admin' ? 'admin' : 'normal', canFuture: true, fullDetail: true };
}

// Whether a no-future tier may load this display day. `day` is 'all' or
// 'YYYY-MM-DD' (the route's normalized cache-key day), `today` the server's
// current 'YYYY-MM-DD'; ISO date strings compare correctly as strings.
// 'all' is allowed - the SQL ceiling in queryRecords bounds it instead, so
// the two views agree: whole days up to and including today, nothing beyond.
export function guestDateAllowed(day, today) {
    if (day == null || day === '' || day === 'all') return true;
    return String(day) <= String(today);
}

// Redacted-tier row fields that carry the internal reasoning (the server-side
// counterpart of the web's VITE_SHOW_DETAILS reduction): the tip blend
// breakdown, the AI adjudicator reasons/reviews and the hot-pick gate audit.
// tip_market/price/outcome and tip_ai_verdict stay - the tip itself and the
// veto strikethrough are baseline table UX, the "why" is the guarded part.
const DETAIL_FIELDS = ['tip_breakdown', 'tip_ai_reason', 'tip_ai_review', 'hot_reason', 'hot_review', 'hot_signals'];

// Exact blend confidence is detail too, but nulling it would kill the guest
// Tip sort/score - quantize to coarse buckets so ordering survives.
const CONFIDENCE_STEP = 0.05;

// Strip ONLY the heavy internal-reasoning JSON (no confidence quantizing) -
// the API_DETAILS=off payload slim for signed-in tiers: a VITE_SHOW_DETAILS=0
// production build never renders these fields, so shipping them (100-750 KB
// on a busy date) is pure wire waste. ONE field list shared with the guest
// redaction below so the two can never drift.
export function stripDetails(row) {
    if (!row) return row;
    const out = { ...row };
    for (const f of DETAIL_FIELDS) if (f in out) out[f] = null;
    return out;
}

// Redact one hydrated queryRecords row for a role. Full-detail roles (and
// null rows) pass through untouched; guests get a copy with the internal
// reasoning stripped and confidence coarsened.
export function redactRecordForRole(row, role) {
    if (!row || role !== 'guest') return row;
    const out = stripDetails(row);
    if (out.tip_confidence != null) {
        out.tip_confidence = Number((Math.round(Number(out.tip_confidence) / CONFIDENCE_STEP) * CONFIDENCE_STEP).toFixed(2));
    }
    return out;
}
