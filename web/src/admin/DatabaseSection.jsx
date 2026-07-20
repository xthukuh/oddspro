import { useCallback, useEffect, useRef, useState } from 'react';
import {
    getDbOverview, getDbHealth, startDbExport, getDbExports, downloadDbExportFile,
    deleteDbExport, uploadDbImportManifest, uploadDbImportChunksSequential,
    getDbImportStatus, applyDbImport, ApiError,
} from '../api.js';
import MultiSelect from '../components/MultiSelect.jsx';

// Admin Database section (M10 Task 5): overview / health / export / import
// over the session-guarded /api/admin/db/* routes (src/db-info.js +
// src/db-transfer.js). Export and import ride the SAME single-slot job as
// data refreshes (src/auto-refresh.js) - they can never overlap a refresh (or
// each other); a busy slot answers 409, surfaced here rather than queued.
// Job progress reuses the poll-while-running idiom from MessagingSection.jsx:
// a 2s interval that runs ONLY while job.running, cleared on unmount.

const TONES = {
    hit: 'text-hit bg-hit/10',
    miss: 'text-miss bg-miss/10',
    hot: 'text-hot bg-hot/10',
    accent: 'text-accent bg-accent/10',
    muted: 'text-label-2 bg-fill',
};
function Chip({ tone = 'muted', title, children }) {
    return (
        <span title={title}
            className={`inline-block text-[10px] font-semibold uppercase tracking-wide rounded px-1.5 py-0.5 whitespace-nowrap ${TONES[tone]}`}>
            {children}
        </span>
    );
}

function Card({ title, hint, children, right }) {
    return (
        <section className="bg-surface rounded-2xl border border-separator-2 p-4">
            <div className="flex items-start gap-2 mb-3">
                <div>
                    <h3 className="text-label text-sm font-semibold">{title}</h3>
                    {hint && <p className="text-label-3 text-[12px] mt-0.5">{hint}</p>}
                </div>
                {right && <div className="ml-auto">{right}</div>}
            </div>
            {children}
        </section>
    );
}

function Stat({ label, value, sub }) {
    return (
        <div className="min-w-0">
            <div className="text-[11px] text-label-2 truncate">{label}</div>
            <div className="text-label text-[15px] font-semibold leading-tight mt-0.5 truncate">{value}</div>
            {sub != null && <div className="text-[11px] text-label-3 truncate mt-0.5">{sub}</div>}
        </div>
    );
}

const inputCls = 'bg-surface border border-separator text-label rounded-lg h-9 px-2.5 text-[13px] outline-none focus:border-accent';
const btnCls = 'cursor-pointer h-9 px-3 rounded-lg text-[12px] bg-fill hover:bg-fill-hover text-label-2 disabled:opacity-40';
const primaryCls = 'cursor-pointer h-9 px-3 rounded-lg text-[12px] bg-accent text-white hover:opacity-90 disabled:opacity-40';
const dangerCls = 'cursor-pointer h-9 px-3 rounded-lg text-[12px] bg-miss text-white hover:opacity-90 disabled:opacity-40 disabled:cursor-default';

const fmtWhen = v => {
    if (v == null) return '–';
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? String(v)
        : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
};
const errText = e => e?.body?.error || e?.message || String(e);

// Display-only byte formatter, mirroring src/db/transfer-rules.js's
// formatBytes() algorithm (iterative division, never a log() formula, to
// avoid float drift misclassifying an exact power-of-1024 boundary). Kept as
// a local copy rather than importing that module: transfer-rules.js pulls in
// zod, which nothing else in web/ bundles today, and this is pure display
// formatting with no decision logic worth the extra dependency.
const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];
function fmtBytes(bytes) {
    const n = Number(bytes);
    if (!Number.isFinite(n) || n <= 0) return '0 B';
    let value = n, unit = 0;
    while (value >= 1024 && unit < BYTE_UNITS.length - 1) { value /= 1024; unit += 1; }
    return `${unit === 0 ? value : value.toFixed(1)} ${BYTE_UNITS[unit]}`;
}
function fmtUptime(s) {
    if (s == null) return '–';
    const days = Math.floor(s / 86400);
    const hours = Math.floor((s % 86400) / 3600);
    const mins = Math.floor((s % 3600) / 60);
    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${mins}m`;
    return `${mins}m`;
}

// Client-side pre-seed ONLY - mirrors src/db/transfer-rules.js's
// DEFAULT_EXCLUDED_TABLES (spec decision 12: auth/session/analytics tables
// carry credentials or would PK-collide across hosts). The server's
// resolveExcluded() unions these in UNCONDITIONALLY regardless of what this
// list sends, so a stale copy here can never widen what actually gets
// excluded - it only affects which checkboxes start pre-ticked.
const DEFAULT_EXCLUDED_TABLES = [
    'users', 'sessions', 'otp_codes', 'user_prefs',
    'visits', 'visit_events', 'visitors', 'visitor_devices', 'visit_sessions',
    'knex_migrations', 'knex_migrations_lock',
];

const BUSY_NOTICE = 'A refresh, export or import is already running on this server - try again once it finishes.';

// --- Overview ----------------------------------------------------------------

function OverviewCard({ overview, error, onReload }) {
    return (
        <Card title="Overview" hint="Read-only snapshot of information_schema + knex_migrations."
            right={<button className={btnCls} onClick={onReload}>Reload</button>}>
            {error ? (
                <p className="text-miss text-[13px]" role="alert">{error}</p>
            ) : !overview ? (
                <p className="text-label-2 text-sm py-4 text-center">Loading…</p>
            ) : (
                <>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
                        <Stat label="Database" value={overview.database} />
                        <Stat label="Server" value={overview.server_version ?? '–'} />
                        <Stat label="Total size" value={fmtBytes(overview.totals.total_bytes)} sub={`${overview.totals.tables} tables`} />
                        <Stat label="Pool" value={overview.pool.used ?? '–'}
                            sub={`free ${overview.pool.free ?? '–'} · pending ${overview.pool.pending_acquires ?? '–'}`} />
                    </div>

                    <div className="mb-4">
                        <div className="flex items-center gap-2 text-[12px]">
                            <span className="text-label-2">Migrations:</span>
                            <span className="text-label font-medium">{overview.migrations.head ?? '(none applied)'}</span>
                            {overview.migrations.up_to_date
                                ? <Chip tone="hit">Up to date</Chip>
                                : <Chip tone="hot">{overview.migrations.pending.length} pending</Chip>}
                        </div>
                        {!overview.migrations.up_to_date && (
                            <ul className="mt-1.5 text-[11px] text-hot bg-hot/10 rounded-lg px-3 py-2 list-disc list-inside">
                                {overview.migrations.pending.map(name => <li key={name}>{name}</li>)}
                            </ul>
                        )}
                    </div>

                    <div className="overflow-x-auto">
                        <table className="w-full text-[12px] min-w-[520px]">
                            <thead>
                                <tr className="text-left text-[11px] text-label-3">
                                    <th className="px-2 py-2 font-medium">Table</th>
                                    <th className="px-2 py-2 font-medium text-right" title="InnoDB engine estimate - not an exact count">Rows (est.)</th>
                                    <th className="px-2 py-2 font-medium text-right">Data</th>
                                    <th className="px-2 py-2 font-medium text-right">Index</th>
                                    <th className="px-2 py-2 font-medium text-right">Total</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-separator-2">
                                {overview.tables.map(t => (
                                    <tr key={t.name}>
                                        <td className="px-2 py-1.5 text-label">{t.name}</td>
                                        <td className="px-2 py-1.5 text-right tabular-nums text-label-2">{t.rows_estimate.toLocaleString()}</td>
                                        <td className="px-2 py-1.5 text-right tabular-nums text-label-2">{fmtBytes(t.data_bytes)}</td>
                                        <td className="px-2 py-1.5 text-right tabular-nums text-label-2">{fmtBytes(t.index_bytes)}</td>
                                        <td className="px-2 py-1.5 text-right tabular-nums text-label font-medium">{fmtBytes(t.total_bytes)}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </>
            )}
        </Card>
    );
}

// --- Health --------------------------------------------------------------

function HealthCard({ health, busy, onCheck }) {
    return (
        <Card title="Health" hint="SELECT 1 latency + SHOW GLOBAL STATUS uptime/connections."
            right={<button className={btnCls} disabled={busy} onClick={onCheck}>{busy ? 'Checking…' : 'Re-check'}</button>}>
            {!health ? (
                <p className="text-label-2 text-sm py-2">Loading…</p>
            ) : health.ok ? (
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    <Stat label="Status" value={<Chip tone="hit">OK</Chip>} />
                    <Stat label="Latency" value={`${health.latency_ms} ms`} />
                    <Stat label="Uptime" value={fmtUptime(health.uptime_s)} />
                    <Stat label="Connections" value={health.threads_connected ?? '–'} />
                </div>
            ) : (
                <div>
                    <Chip tone="miss">Unreachable</Chip>
                    <p className="text-miss text-[12px] mt-1.5">{health.error}</p>
                </div>
            )}
            {health?.checked_at && <p className="text-label-3 text-[11px] mt-2">Checked {fmtWhen(health.checked_at)}</p>}
        </Card>
    );
}

// --- Export ----------------------------------------------------------------

function ExportCard({ tableOptions }) {
    const [exports, setExports] = useState(null);
    const [job, setJob] = useState(null);
    const [excluded, setExcluded] = useState([]);
    const seeded = useRef(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const [deleteFor, setDeleteFor] = useState(null);
    const [deleteTyped, setDeleteTyped] = useState('');
    const [deleteBusy, setDeleteBusy] = useState(false);

    // Pre-seed the exclusion picker with the server's defaults, once, the
    // first time the table catalog arrives (the overview load is async).
    useEffect(() => {
        if (seeded.current || !tableOptions.length) return;
        seeded.current = true;
        setExcluded(tableOptions.filter(o => o.default).map(o => o.key));
    }, [tableOptions]);

    const load = useCallback(async () => {
        try {
            const { exports: list, job: j } = await getDbExports();
            setExports(list);
            setJob(j);
        } catch (e) { setError(errText(e)); }
    }, []);
    useEffect(() => { load(); }, [load]);

    // Poll while a job (export, OR an import - they share the slot) is
    // running; stop as soon as it settles, then the list is already fresh
    // because `load` re-fetches both in one call.
    useEffect(() => {
        if (!job?.running) return undefined;
        const t = setInterval(() => { load(); }, 2000);
        return () => clearInterval(t);
    }, [job?.running, load]);

    const start = async () => {
        setBusy(true);
        setError(null);
        try {
            setJob(await startDbExport(excluded));
        } catch (e) {
            if (e instanceof ApiError && e.status === 409) {
                setError(BUSY_NOTICE);
                setJob(e.body);
            } else {
                setError(errText(e));
            }
        } finally {
            setBusy(false);
        }
    };

    const doDelete = async stamp => {
        setDeleteBusy(true);
        try {
            await deleteDbExport(stamp);
            setDeleteFor(null);
            setDeleteTyped('');
            await load();
        } catch (e) {
            setError(errText(e));
        } finally {
            setDeleteBusy(false);
        }
    };

    const download = (stamp, file) => downloadDbExportFile(stamp, file).catch(e => setError(errText(e)));

    // The Start button (and the banner below) treat ANY running job as busy -
    // export/import ride the SAME single slot as ordinary data refreshes, so a
    // refresh in flight blocks a new export exactly like another export would.
    const jobLabel = job?.mode === 'db-export' ? 'Export' : job?.mode === 'db-import' ? 'Import' : 'A data refresh';

    return (
        <Card title="Export" hint="Chunked NDJSON+gzip dump of the warehouse, streamed to var/exports/ (never held in memory)."
            right={<button className={btnCls} onClick={load}>Reload</button>}>
            <div className="flex flex-wrap items-center gap-2 mb-1.5">
                <MultiSelect label="Exclude tables" options={tableOptions} selected={excluded} onChange={setExcluded}
                    title="Additional tables to skip. Auth/session/analytics tables are always excluded regardless of this picker." />
                <button className={primaryCls} disabled={busy || job?.running} onClick={start}>
                    {job?.running && job.mode === 'db-export' ? 'Exporting…' : 'Start export'}
                </button>
            </div>
            <p className="text-label-3 text-[11px] mb-3">
                users, sessions, otp_codes, user_prefs, visit* and knex_migrations* are always excluded automatically
                (credential/PK-collision safety) - this picker only adds MORE exclusions on top.
            </p>

            {job?.running && (
                <div className="bg-fill rounded-xl px-3 py-2 text-[12px] mb-3">
                    <span className="text-accent">{jobLabel} running…</span>
                    {job.step && <span className="text-label-2"> · {job.step}</span>}
                </div>
            )}
            {error && <p className="text-miss text-[13px] mb-3" role="alert">{error}</p>}

            {!exports ? (
                <p className="text-label-2 text-sm py-4 text-center">Loading exports…</p>
            ) : exports.length === 0 ? (
                <p className="text-label-3 text-[12px]">No exports yet.</p>
            ) : (
                <ul className="divide-y divide-separator-2">
                    {exports.map(e => (
                        <li key={e.stamp} className="py-2.5">
                            <div className="flex flex-wrap items-center gap-2">
                                <span className="text-label text-[13px] font-medium tabular-nums">{e.stamp}</span>
                                {!e.manifest_ok && <Chip tone="miss" title="manifest.json missing or invalid - this export may be incomplete">Incomplete</Chip>}
                                <span className="text-label-3 text-[11px]">{fmtWhen(e.created_at)} · {fmtBytes(e.bytes)}</span>
                                <span className="ml-auto flex gap-1">
                                    <button className={btnCls} onClick={() => { setDeleteFor(e.stamp); setDeleteTyped(''); }}>Delete</button>
                                </span>
                            </div>
                            <div className="flex flex-wrap gap-1.5 mt-1.5">
                                {e.files.map(f => (
                                    <button key={f.name} className="cursor-pointer text-[11px] text-accent hover:opacity-70 bg-fill rounded px-2 py-1"
                                        onClick={() => download(e.stamp, f.name)}>
                                        {f.name} <span className="text-label-3">({fmtBytes(f.bytes)})</span>
                                    </button>
                                ))}
                            </div>
                            {deleteFor === e.stamp && (
                                <div className="mt-2 bg-fill rounded-xl p-3 text-[12px] flex flex-wrap items-center gap-2">
                                    <span className="text-label">Type <b className="font-semibold">DELETE</b> to remove this export permanently:</span>
                                    <input autoFocus className={`${inputCls} w-28`} value={deleteTyped}
                                        onChange={ev => setDeleteTyped(ev.target.value)} placeholder="DELETE" />
                                    <button className={dangerCls} disabled={deleteBusy || deleteTyped !== 'DELETE'} onClick={() => doDelete(e.stamp)}>
                                        {deleteBusy ? 'Deleting…' : 'Delete'}
                                    </button>
                                    <button className={btnCls} disabled={deleteBusy} onClick={() => { setDeleteFor(null); setDeleteTyped(''); }}>Cancel</button>
                                </div>
                            )}
                        </li>
                    ))}
                </ul>
            )}
        </Card>
    );
}

// --- Import wizard -----------------------------------------------------------

function ProgressBar({ done, total, label }) {
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    return (
        <div className="mt-2">
            <div className="h-1.5 rounded-full bg-fill">
                <div className="h-1.5 rounded-full bg-accent" style={{ width: `${pct}%` }} />
            </div>
            <p className="text-label-3 text-[11px] mt-1">{done}/{total} {label}</p>
        </div>
    );
}

function ImportCard({ dbName }) {
    const [manifestFile, setManifestFile] = useState(null);
    const [manifestBusy, setManifestBusy] = useState(false);
    const [manifestResult, setManifestResult] = useState(null); // {stamp, schema_head, tables, rows, upload_plan}
    const [manifestError, setManifestError] = useState(null);
    const [schemaMismatch, setSchemaMismatch] = useState(null); // {manifest_schema_head, local_schema_head}
    const [chunkFiles, setChunkFiles] = useState([]);
    const [uploading, setUploading] = useState(false);
    const [uploadProgress, setUploadProgress] = useState(null);
    const [uploadError, setUploadError] = useState(null);
    const [confirmTyped, setConfirmTyped] = useState('');
    const [applyBusy, setApplyBusy] = useState(false);
    const [applyError, setApplyError] = useState(null);
    const [status, setStatus] = useState(null); // getDbImportStatus() result + embedded job

    const confirmPhrase = `IMPORT ${dbName || ''}`;

    const reset = () => {
        setManifestResult(null);
        setSchemaMismatch(null);
        setManifestError(null);
        setChunkFiles([]);
        setUploadProgress(null);
        setUploadError(null);
        setConfirmTyped('');
        setApplyError(null);
        setStatus(null);
    };

    const pickManifest = async file => {
        setManifestFile(file ?? null);
        reset();
        if (!file) return;
        setManifestBusy(true);
        try {
            const text = await file.text();
            let parsed;
            try {
                parsed = JSON.parse(text);
            } catch {
                throw new Error('That file is not valid JSON.');
            }
            const res = await uploadDbImportManifest(parsed);
            setManifestResult(res);
            setStatus(await getDbImportStatus(res.stamp));
        } catch (e) {
            if (e instanceof ApiError && e.status === 409 && e.body?.manifest_schema_head !== undefined) {
                setSchemaMismatch(e.body);
            } else {
                setManifestError(errText(e));
            }
        } finally {
            setManifestBusy(false);
        }
    };

    const uploadChunks = async () => {
        if (!manifestResult) return;
        setUploading(true);
        setUploadError(null);
        setUploadProgress({ done: 0, total: manifestResult.upload_plan.length });
        const byName = new Map(chunkFiles.map(f => [f.name, f]));
        try {
            await uploadDbImportChunksSequential(
                manifestResult.stamp, manifestResult.upload_plan,
                name => byName.get(name),
                p => setUploadProgress(p),
            );
            setStatus(await getDbImportStatus(manifestResult.stamp));
        } catch (e) {
            setUploadError(errText(e));
        } finally {
            setUploading(false);
        }
    };

    const doApply = async () => {
        if (!manifestResult) return;
        setApplyBusy(true);
        setApplyError(null);
        try {
            const job = await applyDbImport(manifestResult.stamp, confirmTyped.trim());
            setStatus(prev => ({ ...(prev ?? {}), job }));
        } catch (e) {
            setApplyError(e instanceof ApiError && e.status === 409 ? BUSY_NOTICE : errText(e));
        } finally {
            setApplyBusy(false);
        }
    };

    // Poll while the apply job (or the safety export ahead of it) is running;
    // stop the moment it settles - same idiom as MessagingSection's send poll.
    useEffect(() => {
        if (!manifestResult?.stamp) return undefined;
        if (!status?.job?.running) return undefined;
        const t = setInterval(() => {
            getDbImportStatus(manifestResult.stamp).then(setStatus).catch(() => {});
        }, 2000);
        return () => clearInterval(t);
    }, [status?.job?.running, manifestResult?.stamp]);

    const jobRunning = status?.job?.running;

    return (
        <Card title="Import" hint="Upload an export's manifest, upload its chunk files, then apply.">
            <p className="text-label-3 text-[11px] bg-fill rounded-lg px-3 py-2 mb-3">
                Applying backs up the FULL warehouse first (a safety export, ~1.6 GB on this host) before writing
                a single row - and export/import share the same job slot as data refreshes, so this can take a
                while and blocks refreshes (and each other) until it finishes.
            </p>

            <div className="flex flex-wrap items-center gap-2 mb-1">
                <label className={btnCls}>
                    {manifestBusy ? 'Validating…' : 'Choose manifest.json…'}
                    <input type="file" accept="application/json,.json" className="hidden" disabled={manifestBusy}
                        onChange={ev => pickManifest(ev.target.files?.[0] ?? null)} />
                </label>
                {manifestFile && <span className="text-label-2 text-[12px]">{manifestFile.name}</span>}
            </div>
            {manifestError && <p className="text-miss text-[13px] mb-3" role="alert">{manifestError}</p>}

            {/* Non-dismissible: cleared only by picking a different (compatible)
                manifest file via pickManifest's reset() - never by a close button.
                Importing rows shaped by a different schema is how the warehouse
                gets corrupted, so this stays in front of the admin. */}
            {schemaMismatch && (
                <div className="border border-miss bg-miss/10 rounded-xl p-3 text-[12px] mb-3">
                    <div className="text-miss font-semibold">Schema mismatch - import blocked</div>
                    <p className="text-label mt-1">
                        This manifest was exported from a different migration state. Importing it could corrupt this warehouse.
                    </p>
                    <div className="mt-1.5 text-label-2 flex flex-col gap-0.5">
                        <span>Manifest schema head: <span className="tabular-nums text-label">{schemaMismatch.manifest_schema_head}</span></span>
                        <span>This server's schema head: <span className="tabular-nums text-label">{schemaMismatch.local_schema_head}</span></span>
                    </div>
                    <p className="text-label-3 mt-1.5">Migrate this server to match, or use an export from a server on the same schema.</p>
                </div>
            )}

            {manifestResult && !schemaMismatch && (
                <div className="mb-3">
                    <p className="text-label-2 text-[12px] mb-2">
                        {manifestResult.tables} tables · {manifestResult.rows.toLocaleString()} rows · schema {manifestResult.schema_head}
                    </p>
                    <div className="flex flex-wrap items-center gap-2">
                        <label className={btnCls}>
                            Choose chunk files…
                            <input type="file" multiple className="hidden"
                                onChange={ev => setChunkFiles(Array.from(ev.target.files ?? []))} />
                        </label>
                        <span className="text-label-2 text-[12px]">{chunkFiles.length} file{chunkFiles.length === 1 ? '' : 's'} picked</span>
                        <button className={primaryCls} disabled={!chunkFiles.length || uploading} onClick={uploadChunks}>
                            {uploading ? 'Uploading…' : 'Upload chunks'}
                        </button>
                    </div>
                    {uploadProgress && <ProgressBar done={uploadProgress.done} total={uploadProgress.total} label="chunks uploaded" />}
                    {uploadError && <p className="text-miss text-[13px] mt-2" role="alert">{uploadError}</p>}
                </div>
            )}

            {status && !schemaMismatch && (
                <div className="border-t border-separator-2 pt-3">
                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-label-2 mb-2">
                        <span>{status.uploaded_files}/{status.total_files} files staged</span>
                        {status.missing_files?.length > 0 && <span className="text-hot">{status.missing_files.length} missing</span>}
                        <span>{status.applied_chunks} chunk{status.applied_chunks === 1 ? '' : 's'} applied</span>
                        {status.apply_complete && <Chip tone="hit">Apply complete</Chip>}
                    </div>

                    {jobRunning ? (
                        <div className="bg-fill rounded-xl px-3 py-2 text-[12px]">
                            <span className="text-accent">
                                {status.job.mode === 'db-export' ? 'Export' : status.job.mode === 'db-import' ? 'Import' : 'A data refresh'} running…
                            </span>
                            {status.job.step && <span className="text-label-2"> · {status.job.step}</span>}
                        </div>
                    ) : status.apply_complete ? (
                        <p className="text-hit text-[13px]">Import applied successfully.</p>
                    ) : status.job?.error ? (
                        <p className="text-miss text-[13px]">{status.job.error}</p>
                    ) : (
                        <div className="flex flex-wrap items-center gap-2">
                            <span className="text-label-2 text-[12px]">
                                Type <b className="text-label font-semibold">{confirmPhrase}</b> to apply:
                            </span>
                            <input className={`${inputCls} w-64`} value={confirmTyped} disabled={!status.ready_to_apply}
                                onChange={ev => setConfirmTyped(ev.target.value)} placeholder={confirmPhrase} />
                            <button className={dangerCls} disabled={applyBusy || !status.ready_to_apply || confirmTyped.trim() !== confirmPhrase}
                                onClick={doApply}>
                                {applyBusy ? 'Applying…' : 'Apply import'}
                            </button>
                        </div>
                    )}
                    {!status.ready_to_apply && !status.apply_complete && !jobRunning && (
                        <p className="text-label-3 text-[11px] mt-1.5">Upload every chunk file before applying.</p>
                    )}
                    {applyError && <p className="text-miss text-[13px] mt-2" role="alert">{applyError}</p>}
                </div>
            )}
        </Card>
    );
}

// --- Section shell -----------------------------------------------------------

export default function DatabaseSection() {
    const [overview, setOverview] = useState(null);
    const [overviewError, setOverviewError] = useState(null);
    const [health, setHealth] = useState(null);
    const [healthBusy, setHealthBusy] = useState(false);

    const loadOverview = useCallback(async () => {
        setOverviewError(null);
        try {
            setOverview(await getDbOverview());
        } catch (e) {
            setOverviewError(errText(e));
        }
    }, []);
    const loadHealth = useCallback(async () => {
        setHealthBusy(true);
        try {
            setHealth(await getDbHealth());
        } catch (e) {
            setHealth({ ok: false, error: errText(e), checked_at: new Date().toISOString() });
        } finally {
            setHealthBusy(false);
        }
    }, []);

    useEffect(() => { loadOverview(); loadHealth(); }, [loadOverview, loadHealth]);

    const tableOptions = (overview?.tables ?? [])
        .map(t => ({ key: t.name, label: t.name, default: DEFAULT_EXCLUDED_TABLES.includes(t.name) }))
        .sort((a, b) => a.label.localeCompare(b.label));

    return (
        <div className="flex flex-col gap-4">
            <OverviewCard overview={overview} error={overviewError} onReload={loadOverview} />
            <HealthCard health={health} busy={healthBusy} onCheck={loadHealth} />
            <ExportCard tableOptions={tableOptions} />
            <ImportCard dbName={overview?.database} />
        </div>
    );
}
