// Persistence for the model-triage add-on: ONE append-only JSON-blob table
// (`model_triage`, migration batch 20). The knex handle is INJECTED - this
// module imports nothing from oddspro (extraction seam; index.js is the only
// file that touches oddspro config/db). Append-only by design: diffs are
// derivable from consecutive snapshots, and the newest row per kind is the
// only read pattern.

export async function saveRow(db, kind, payload) {
    const [id] = await db('model_triage').insert({ kind, payload: JSON.stringify(payload) });
    return id;
}

// Newest row of a kind, payload decoded. mysql2 may hand a JSON column back
// as a string or an object depending on driver settings - tolerate both; a
// corrupt blob decodes to null rather than throwing (the reader treats it as
// "no data yet").
export async function latestRow(db, kind) {
    const row = await db('model_triage').where('kind', kind).orderBy('id', 'desc').first();
    if (!row) return null;
    let payload = row.payload;
    if (typeof payload === 'string') {
        try {
            payload = JSON.parse(payload);
        } catch {
            payload = null;
        }
    }
    return { id: row.id, kind: row.kind, created_at: row.created_at, payload };
}
