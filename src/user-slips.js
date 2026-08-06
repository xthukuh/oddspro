// Shareable user slips service (engine-v2 Phase 4): thin knex orchestration,
// the pats.js/auth.js loader idiom. Legs arrive from the client but are
// SANITIZED to a closed scalar shape here (external data discipline) - the
// server recomputes combined odds and never trusts client arithmetic.
import { db } from './db/connection.js';
import { FINAL_STATUSES } from './apisports.js';
import { tipOutcome } from './db/tip-rules.js';
import { slipOutcomeRollup } from './db/daily-slip-rules.js';
import { generateSlipCode, normalizeSlipCode } from './slip-code.js';

const MAX_LEGS = 30;

// Closed leg shape: anything else the client sends is dropped, not stored.
function _sanitizeLeg(l) {
    const fixture_id = Number(l?.fixture_id);
    const price = Number(l?.price);
    const market = typeof l?.market === 'string' ? l.market.slice(0, 32) : null;
    if (!Number.isInteger(fixture_id) || fixture_id <= 0 || !(price > 1) || !market) return null;
    return {
        fixture_id, market, price,
        label: typeof l?.label === 'string' ? l.label.slice(0, 80) : null,
        home: typeof l?.home === 'string' ? l.home.slice(0, 80) : null,
        away: typeof l?.away === 'string' ? l.away.slice(0, 80) : null,
        league: typeof l?.league === 'string' ? l.league.slice(0, 80) : null,
        kickoff: typeof l?.kickoff === 'string' ? l.kickoff.slice(0, 32) : null,
        prob: Number.isFinite(Number(l?.prob)) ? Number(l.prob) : null,
        outcome: ['hit', 'miss', 'void'].includes(l?.outcome) ? l.outcome : null,
    };
}

export async function saveUserSlip({ userId, title = null, legs, sourceCode = null }) {
    const clean = (Array.isArray(legs) ? legs : []).map(_sanitizeLeg).filter(Boolean).slice(0, MAX_LEGS);
    if (clean.length < 1) { const e = new Error('a slip needs at least one valid leg'); e.status = 400; throw e; }
    const combined = Math.round(clean.reduce((p, l) => p * l.price, 1) * 100) / 100;
    // Collision-retried insert: at ~1e9 codes a retry is cosmically rare, but
    // the unique index makes even the race loser safe.
    for (let attempt = 0; attempt < 5; attempt++) {
        const code = generateSlipCode();
        try {
            const [id] = await db('user_slips').insert({
                user_id: userId, code,
                title: title ? String(title).slice(0, 80) : null,
                legs: JSON.stringify(clean),
                combined_odds: combined, legs_total: clean.length,
                source_code: sourceCode ? normalizeSlipCode(sourceCode) : null,
            });
            return await getUserSlip(id);
        } catch (e) {
            if (e?.code !== 'ER_DUP_ENTRY') throw e;
        }
    }
    throw new Error('could not mint a unique slip code');
}

const _out = r => r && ({
    id: r.id, user_id: r.user_id, code: r.code, title: r.title,
    legs: typeof r.legs === 'string' ? JSON.parse(r.legs) : r.legs,
    combined_odds: r.combined_odds == null ? null : Number(r.combined_odds),
    legs_total: r.legs_total, legs_hit: r.legs_hit, outcome: r.outcome,
    source_code: r.source_code, created_at: r.created_at, settled_at: r.settled_at,
});

export async function getUserSlip(id) {
    return _out(await db('user_slips').where('id', id).first());
}

// The owner's personal timeline: created_at IS the chronological stamp.
export async function listUserSlips(userId, limit = 100) {
    const rows = await db('user_slips').where('user_id', userId)
        .orderBy('created_at', 'desc').limit(Math.min(500, limit));
    return rows.map(_out);
}

// Load by share code (any signed-in user): the slip opens in edit mode
// client-side; saving mints the caller's OWN copy with a new code and
// source_code provenance. The owner's identity is not exposed.
export async function getSlipByCode(code) {
    const norm = normalizeSlipCode(code);
    if (!norm) return null;
    const r = await db('user_slips').where('code', norm).first();
    if (!r) return null;
    const { user_id, ...pub } = _out(r);
    return pub;
}

export async function deleteUserSlip(userId, id) {
    return db('user_slips').where({ id, user_id: userId }).del();
}

// Settle pending user slips from canonical final scores - the daily-slip
// settle idiom verbatim (light-pass cheap, leg outcomes into the JSON,
// outcome/legs_hit/settled_at written exactly once).
export async function settleUserSlips() {
    const pending = await db('user_slips').whereNull('outcome').select('id', 'legs');
    if (!pending.length) return { settled: 0, pending: 0 };
    const parsed = pending.map(r => ({ id: r.id, legs: typeof r.legs === 'string' ? JSON.parse(r.legs) : (r.legs ?? []) }));
    const ids = [...new Set(parsed.flatMap(r => r.legs.map(l => l.fixture_id)))];
    if (!ids.length) return { settled: 0, pending: pending.length };
    const finals = await db('fixtures').whereIn('id', ids)
        .whereIn('status', FINAL_STATUSES)
        .whereNotNull('ft_home').whereNotNull('ft_away')
        .select('id', 'ft_home', 'ft_away');
    const byId = new Map(finals.map(f => [f.id, f]));
    let settled = 0;
    for (const r of parsed) {
        let changed = false;
        for (const l of r.legs) {
            if (l.outcome != null) continue;
            const f = byId.get(l.fixture_id);
            if (!f) continue;
            try { l.outcome = tipOutcome(l.market, f.ft_home, f.ft_away); changed = true; } catch { /* unknown market key: leave pending */ }
        }
        const roll = slipOutcomeRollup(r.legs.map(l => l.outcome ?? null));
        if (!changed && roll.outcome == null) continue;
        const patch = { legs: JSON.stringify(r.legs), legs_hit: roll.legsHit };
        if (roll.outcome != null) { patch.outcome = roll.outcome; patch.settled_at = db.fn.now(); settled++; }
        await db('user_slips').where('id', r.id).update(patch);
    }
    return { settled, pending: pending.length };
}
