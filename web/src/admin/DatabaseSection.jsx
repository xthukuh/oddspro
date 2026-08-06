import { useCallback, useEffect, useRef, useState } from 'react';
import { getDbOverview, getDbHealth } from '../api.js';

// Admin Database section: overview + health over the session-guarded
// /api/admin/db/* reads (src/db-info.js). The export/import transfer UI was
// removed 2026-08-07 (core-focus trim) - DB copies now go over SSH via
// scripts/deploy-remote.js; git history has the old wizard.

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

    return (
        <div className="flex flex-col gap-4">
            <OverviewCard overview={overview} error={overviewError} onReload={loadOverview} />
            <HealthCard health={health} busy={healthBusy} onCheck={loadHealth} />
        </div>
    );
}
