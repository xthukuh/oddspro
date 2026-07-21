// Portable config snapshot (.oddspro): a gzip-compressed, versioned JSON
// envelope of the user's localStorage preferences, so a full setup can move
// between app instances (dev <-> prod). The `version` + migrateEnvelope() chain
// keeps older snapshots loadable as the key set evolves (backwards compat).
//
// Split into a PURE core (buildEnvelope / parseEnvelope / migrateEnvelope -
// node-testable, no browser globals at module load) and browser IO
// (collect/apply + gzip/download/read) that touches localStorage,
// Compression/DecompressionStream and the DOM only inside the call.

export const SNAPSHOT_FORMAT = 'oddspro.config';
export const SNAPSHOT_VERSION = 1;
const PREFIX = 'oddspro.';
// Transient, per-date row selections (oddspro.select.d.<date>) are data, not
// config - they'd bloat the snapshot and mean nothing on another day/instance.
// The prefs-sync cursor (oddspro.prefs.sync, v1.1.0 Phase 7) is likewise this
// device's own sync clock: exporting it is noise, importing another device's
// would corrupt sync state. Exported for the offline exclusion tests.
export const isTransient = key => key.startsWith('oddspro.select.d.') || key === 'oddspro.prefs.sync'
    || key === 'oddspro.maintenance' // M14 schedule cache - server state, not config
    // The anonymous analytics id: device identity, not configuration. Exporting
    // it puts a tracking identifier in a shareable file, and importing one
    // clones another device's visitor identity into this browser.
    || key === 'oddspro.visitor';
// Per-device credentials (the session + human-verification tokens) are
// secrets, not preferences: they must never leave the device in an export,
// and an import must neither install another device's tokens nor wipe this
// device's own (importing config should not log the user out). Exported so
// the exclusion rule is offline-testable alongside the pure core.
export const isSecret = key => key === 'oddspro.session' || key === 'oddspro.human';

// --- pure core ------------------------------------------------------------

// Wrap a { key: value } config map in the current envelope. `app` = the source
// app version (provenance only), `savedAt` = ISO timestamp.
export function buildEnvelope(data, app = null) {
    return { format: SNAPSHOT_FORMAT, version: SNAPSHOT_VERSION, app, savedAt: new Date().toISOString(), data: { ...data } };
}

// Bring an older envelope up to the current shape. Each step upgrades exactly
// one version, so a v1 snapshot opened by a future v3 app runs 1->2->3. No
// migrations yet (v1 is the first format); future key renames slot in here.
export function migrateEnvelope(env) {
    let e = env;
    // if (e.version === 1) { e = { ...e, version: 2, data: /* rename */ e.data }; }
    return e;
}

// Validate + migrate a parsed object into a usable envelope, or throw a
// human-readable error. Tolerant of a missing app/savedAt (provenance only).
export function parseEnvelope(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('Not a valid Odds Pro config file.');
    if (obj.format !== SNAPSHOT_FORMAT) throw new Error('Unrecognized file - not an Odds Pro config snapshot.');
    if (!Number.isInteger(obj.version) || obj.version < 1) throw new Error('Config file has an invalid version.');
    if (obj.version > SNAPSHOT_VERSION) throw new Error(`This config was saved by a newer app (v${obj.version}); update Odds Pro to import it.`);
    if (!obj.data || typeof obj.data !== 'object' || Array.isArray(obj.data)) throw new Error('Config file has no settings payload.');
    const migrated = migrateEnvelope(obj);
    return { version: migrated.version, app: migrated.app ?? null, savedAt: migrated.savedAt ?? null, data: migrated.data };
}

// --- browser IO -----------------------------------------------------------

// Every persisted oddspro.* preference except the transient per-date
// selections and the per-device secrets.
export function collectConfig() {
    const data = {};
    for (const k of Object.keys(localStorage)) {
        if (k.startsWith(PREFIX) && !isTransient(k) && !isSecret(k)) data[k] = localStorage.getItem(k);
    }
    return data;
}

// Replace the user's config wholesale: drop every oddspro.* key (a clean slate,
// so stale keys can't linger), then write the snapshot's entries verbatim.
// Secrets are out of scope both ways: this device's tokens survive, and any
// tokens embedded in an older snapshot are refused.
export function applyConfig(data) {
    for (const k of Object.keys(localStorage)) {
        if (k.startsWith(PREFIX) && !isSecret(k)) localStorage.removeItem(k);
    }
    for (const [k, v] of Object.entries(data)) {
        if (!isSecret(k) && !isTransient(k)) localStorage.setItem(k, String(v));
    }
}

async function gzip(str) {
    const cs = new CompressionStream('gzip');
    const buf = await new Response(new Blob([str]).stream().pipeThrough(cs)).arrayBuffer();
    return new Uint8Array(buf);
}
async function gunzip(bytes) {
    const ds = new DecompressionStream('gzip');
    return await new Response(new Blob([bytes]).stream().pipeThrough(ds)).text();
}

// Build the envelope from the current config, gzip it, and download a
// timestamped .oddspro file. Returns the number of keys exported.
export async function exportConfig(app = null) {
    const env = buildEnvelope(collectConfig(), app);
    const gz = await gzip(JSON.stringify(env));
    const blob = new Blob([gz], { type: 'application/gzip' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `oddspro-config-${new Date().toISOString().slice(0, 10)}.oddspro`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    return Object.keys(env.data).length;
}

// Read a .oddspro file, validate/migrate, then clear + apply. Returns the key
// count; the CALLER reloads so React re-reads localStorage from scratch.
export async function importConfig(file) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let text;
    try { text = await gunzip(bytes); }
    catch { throw new Error('Could not read the file - is it a .oddspro config export?'); }
    let obj;
    try { obj = JSON.parse(text); }
    catch { throw new Error('Config file is corrupted (invalid JSON).'); }
    const env = parseEnvelope(obj);
    applyConfig(env.data);
    return Object.keys(env.data).length;
}
