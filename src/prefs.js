import { db } from './db/connection.js';

// Cross-device prefs persistence (v1.1.0 Phase 7): thin knex loader over
// `user_prefs` (one JSON blob per user, migration batch 11). The LWW protocol
// lives in pure src/db/prefs-rules.js; this module only enforces the server
// side of it atomically: a write lands ONLY when its version is strictly
// newer than the stored row, otherwise the current row comes back as the
// conflict for the client to reconcile (409).

// -> { data, version, updated_at } | null. MariaDB's JSON column is a LONGTEXT
// alias, so mysql2 returns the blob as a string - parse defensively (same
// coerce-what-the-driver-gives idiom as lab-rules' _num for DECIMAL strings).
export async function getUserPrefs(userId) {
    const row = await db('user_prefs')
        .select('data', 'version', 'updated_at')
        .where('user_id', userId)
        .first();
    if (!row) return null;
    let data = row.data;
    if (typeof data === 'string') {
        try { data = JSON.parse(data); } catch { data = {}; }
    }
    return { data: data ?? {}, version: Number(row.version) || 0, updated_at: row.updated_at };
}

// Conditional LWW write. Returns { version, updated_at } on success or
// { conflict: <current row> } when the stored version is already >= the
// incoming one. Atomic without a transaction: the UPDATE's `version <
// incoming` predicate decides winner-vs-loser inside the row lock, and a
// raced first-INSERT loser hits the PK and re-reads the winner.
export async function saveUserPrefs(userId, data, version) {
    const payload = JSON.stringify(data);
    const updated = await db('user_prefs')
        .where('user_id', userId)
        .where('version', '<', version)
        .update({ data: payload, version, updated_at: db.fn.now() });
    if (!updated) {
        const existing = await getUserPrefs(userId);
        if (existing) return { conflict: existing };
        try {
            await db('user_prefs').insert({ user_id: userId, data: payload, version });
        } catch (e) {
            if (e?.code !== 'ER_DUP_ENTRY') throw e;
            return { conflict: await getUserPrefs(userId) };
        }
    }
    const row = await getUserPrefs(userId);
    return { version: row.version, updated_at: row.updated_at };
}
