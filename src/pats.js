// Personal-access-token service (engine-v2 Phase 2): thin knex orchestration
// over the pure src/pat-rules.js, the auth.js/magic.js loader idiom. The
// plaintext token exists exactly once, in createPat's return value; lists and
// audit rows carry only the display prefix.
import { db } from './db/connection.js';
import { mintPat, hashPatToken } from './pat-rules.js';

// Mint a token for a user. Returns { token, pat } - token is shown ONCE.
// Audit rows ride the same transaction (the admin-users M6 discipline).
export async function createPat({ userId, name, expiresDays = null, actorId = null }) {
    const minted = mintPat();
    const expiresAt = expiresDays > 0
        ? db.raw('DATE_ADD(NOW(), INTERVAL ? DAY)', [Number(expiresDays)])
        : null;
    let id = null;
    await db.transaction(async trx => {
        const [insertId] = await trx('personal_access_tokens').insert({
            user_id: userId, name: String(name).slice(0, 64),
            token_hash: minted.hash, prefix: minted.prefix,
            scopes: JSON.stringify(['read']),
            expires_at: expiresAt, created_by: actorId,
        });
        id = insertId;
        await trx('admin_audit').insert({
            actor_id: actorId, action: 'pat.create',
            target: `pat:${insertId}:user:${userId}`,
            old_value: null, new_value: minted.prefix,
        });
    });
    const pat = await db('personal_access_tokens').where('id', id).first();
    return { token: minted.token, pat: _patView(pat) };
}

export async function listPats() {
    const rows = await db('personal_access_tokens as p')
        .leftJoin('users as u', 'u.id', 'p.user_id')
        .orderBy('p.id', 'desc')
        .select('p.*', 'u.phone as user_phone', 'u.name as user_name');
    return rows.map(_patView);
}

// Idempotent revoke; audits only a real transition.
export async function revokePat(id, actorId = null) {
    await db.transaction(async trx => {
        const n = await trx('personal_access_tokens')
            .where('id', id).whereNull('revoked_at')
            .update({ revoked_at: db.fn.now() });
        if (n) {
            await trx('admin_audit').insert({
                actor_id: actorId, action: 'pat.revoke',
                target: `pat:${id}`, old_value: 'active', new_value: 'revoked',
            });
        }
    });
    return true;
}

// Bearer resolution: hash lookup, live checks (revoked/expired/user active),
// last_used_at throttled to ~1/min (the sessions last_seen_at idiom).
export async function resolvePat(token) {
    const row = await db('personal_access_tokens as p')
        .join('users as u', 'u.id', 'p.user_id')
        .where('p.token_hash', hashPatToken(token))
        .whereNull('p.revoked_at')
        .whereRaw('(p.expires_at IS NULL OR p.expires_at > NOW())')
        .where('u.is_active', 1)
        .select('p.id as pat_id', 'p.name as pat_name', 'p.last_used_at', 'u.*')
        .first();
    if (!row) return null;
    const { pat_id, pat_name, last_used_at, ...user } = row;
    if (!last_used_at || (Date.now() - new Date(last_used_at).getTime()) > 60_000) {
        db('personal_access_tokens').where('id', pat_id)
            .update({ last_used_at: db.fn.now() })
            .catch(() => {});   // best-effort telemetry, never fails a request
    }
    return { user, pat: { id: pat_id, name: pat_name } };
}

// Ops projection: never token_hash (the adminUserView discipline).
function _patView(p) {
    if (!p) return null;
    return {
        id: p.id, user_id: p.user_id,
        user_phone: p.user_phone ?? null, user_name: p.user_name ?? null,
        name: p.name, prefix: p.prefix,
        scopes: typeof p.scopes === 'string' ? JSON.parse(p.scopes) : p.scopes,
        last_used_at: p.last_used_at, expires_at: p.expires_at,
        revoked_at: p.revoked_at, created_at: p.created_at,
    };
}
