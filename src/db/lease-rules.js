// Pure rules for the single-writer lease over MariaDB GET_LOCK (zero
// imports, offline-tested). `lockOutcome` reads the row shape returned by
// `SELECT GET_LOCK(?, 0) AS got`; `leaseTransition` is the gained/lost state
// machine the lease tick logs once per edge.

export const WRITER_LOCK = 'oddspro:writer';

export function lockOutcome(rows) {
    const got = Array.isArray(rows) && rows.length > 0 ? rows[0].got : undefined;
    if (got === 1) return 'acquired';
    if (got === 0) return 'held-elsewhere';
    return 'error';
}

export function leaseTransition(prev, outcome) {
    const was = !!prev;
    const now = outcome === 'acquired';
    const changed = was !== now;
    const event = !changed ? null : (now ? 'gained' : 'lost');
    return { was, now, changed, event };
}
