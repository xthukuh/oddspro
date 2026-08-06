import { useCallback, useEffect, useRef, useState } from 'react';
import { getAdminTriage, runAdminTriage, putAdminSettings } from '../api.js';
import { Switch } from './SettingsEditor.jsx';

// Admin "Models" section (src/modeltriage/, 2026-08-04 design spec): the
// current per-task shortlist with pros/cons and PRIMARY/FALLBACK badges, the
// catalog events feed, and the auto-switch guardrail toggle. Adopting a model
// and flipping the toggles all write through the STANDARD settings PUT, so
// every change lands a dated admin_audit row - this card has no privileged
// write path of its own.

const TASK_ORDER = ['adjudicate', 'facts', 'blind', 'anchored', 'bulk'];

const perM = v => (v == null ? '–' : `$${(Number(v) * 1e6).toFixed(2)}`);
const fmtCtx = v => (v == null ? '–' : `${Math.round(Number(v) / 1000)}k`);
const fmtWhen = v => (v == null ? 'never' : new Date(v).toLocaleString());

function Badge({ cls, children, title }) {
    return <span title={title} className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold ${cls}`}>{children}</span>;
}

function ProbeDots({ qual }) {
    if (!qual) return <span className="text-label-3 text-[11px]" title="Not yet probe-qualified">unprobed</span>;
    return (
        <span className="inline-flex gap-1">
            {['json', 'reason', 'latency'].map(k => {
                const p = qual.probes?.[k];
                const state = p == null ? '·' : p.pass ? '✓' : '✗';
                const cls = p == null ? 'text-label-3' : p.pass ? 'text-hit' : 'text-miss';
                return (
                    <span key={k} className={`${cls} text-[11px]`}
                        title={`${k} probe: ${p == null ? 'not run' : p.pass ? `pass (${p.ms}ms)` : `fail - ${p.note ?? ''}`}`}>
                        {state}
                    </span>
                );
            })}
        </span>
    );
}

function Card({ title, note, children, right }) {
    return (
        <div className="bg-surface border border-separator-2 rounded-2xl p-4 min-w-0">
            <div className="flex items-start gap-2">
                <div className="flex-1 min-w-0">
                    <h3 className="text-[13px] font-semibold text-label">{title}</h3>
                    {note != null && <p className="text-[11px] text-label-3 mt-0.5">{note}</p>}
                </div>
                {right}
            </div>
            {children}
        </div>
    );
}

function TaskCard({ task, data, live, autoSwitch, busy, onAdopt }) {
    const rows = data.candidates ?? [];
    return (
        <Card
            title={data.label ?? task}
            note={live ? <>Live: <code className="text-label">{live}</code></> : 'No live routing (advisory shortlist only)'}
        >
            {!rows.length && <p className="text-[12px] text-label-3 mt-2">No qualifying candidates in the last pass.</p>}
            {rows.length > 0 && (
                <div className="mt-2 overflow-x-auto">
                    <table className="w-full text-[12px]">
                        <thead>
                            <tr className="text-left text-[11px] text-label-3">
                                <th className="pr-3 py-1 font-medium">Model</th>
                                <th className="pr-3 py-1 font-medium">$/M in · out</th>
                                <th className="pr-3 py-1 font-medium">Context</th>
                                <th className="pr-3 py-1 font-medium">JSON</th>
                                <th className="pr-3 py-1 font-medium">Uptime</th>
                                <th className="pr-3 py-1 font-medium">Probes</th>
                                <th className="py-1 font-medium">Score</th>
                            </tr>
                        </thead>
                        <tbody>
                            {rows.map(c => (
                                <tr key={c.id} className="border-t border-separator-2 align-top">
                                    <td className="pr-3 py-1.5">
                                        <div className="flex items-center gap-1.5 flex-wrap">
                                            <code className={c.id === live ? 'text-accent font-semibold' : 'text-label'}>{c.id}</code>
                                            {c.id === live && <Badge cls="bg-accent/10 text-accent">LIVE</Badge>}
                                            {c.id === data.primary && <Badge cls="bg-hit/10 text-hit">PRIMARY</Badge>}
                                            {c.id === data.fallback && <Badge cls="bg-fill text-label-2">FALLBACK</Badge>}
                                            {c.free && <Badge cls="bg-hot/10 text-hot">free</Badge>}
                                        </div>
                                        <div className="text-[11px] text-label-3 mt-0.5 max-w-md"
                                            title={[...(c.pros ?? []), ...(c.cons ?? [])].join('\n')}>
                                            {(c.pros ?? []).map(p => `+ ${p}`).join('  ')}
                                            {(c.cons ?? []).length > 0 && '  '}
                                            {(c.cons ?? []).map(x => `− ${x}`).join('  ')}
                                        </div>
                                    </td>
                                    <td className="pr-3 py-1.5 whitespace-nowrap text-label-2">{perM(c.pricing?.prompt)} · {perM(c.pricing?.completion)}</td>
                                    <td className="pr-3 py-1.5 text-label-2">{fmtCtx(c.context)}</td>
                                    <td className="pr-3 py-1.5">{c.qual?.probes?.json?.pass ?? false
                                        ? <Badge cls="bg-hit/10 text-hit" title="Passed the strict-JSON contract probe">JSON ✓</Badge>
                                        : <span className="text-label-3">–</span>}</td>
                                    <td className="pr-3 py-1.5 text-label-2">{c.uptime == null ? '–' : `${Number(c.uptime).toFixed(1)}%`}</td>
                                    <td className="pr-3 py-1.5"><ProbeDots qual={c.qual} /></td>
                                    <td className="py-1.5 text-label-2">{c.score == null ? '–' : Number(c.score).toFixed(3)}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
            {/* Adopt: only when auto-switch is OFF, a primary exists and it differs
                from the live model. Writes the routing key through the standard
                settings PUT - identical to editing it in Admin -> Settings. */}
            {!autoSwitch && data.settingKey && data.primary && data.primary !== live && (
                <button disabled={busy} onClick={() => onAdopt(task, data.settingKey, data.primary)}
                    className="mt-2 cursor-pointer h-8 px-3 rounded-lg bg-accent text-white text-[12px] font-medium disabled:opacity-50">
                    Adopt {data.primary}
                </button>
            )}
        </Card>
    );
}

export default function ModelsSection() {
    const [state, setState] = useState(null);
    const [error, setError] = useState(null);
    const [busy, setBusy] = useState(false);
    const [notice, setNotice] = useState(null);
    const pollRef = useRef(null);

    const load = useCallback(() => getAdminTriage().then(s => { setState(s); return s; }).catch(e => setError(e.message)), []);
    useEffect(() => { load(); return () => clearInterval(pollRef.current); }, [load]);

    // After "Run triage now": poll until the pass finishes, then show the result.
    const pollUntilDone = useCallback(() => {
        clearInterval(pollRef.current);
        pollRef.current = setInterval(async () => {
            const s = await getAdminTriage().catch(() => null);
            if (s) setState(s);
            if (s && !s.status.running) {
                clearInterval(pollRef.current);
                setNotice('Triage pass finished.');
            }
        }, 3000);
    }, []);

    if (error && !state) return <p className="text-miss text-[13px]" role="alert">Model triage failed to load: {error}</p>;
    if (!state) return <p className="text-label-3 text-[13px]">Loading…</p>;

    const { status, routing, shortlist } = state;
    const events = shortlist?.events ?? null;

    async function setKnob(key, value) {
        setBusy(true);
        setError(null);
        try {
            await putAdminSettings({ [key]: value });
            await load();
        } catch (e) {
            setError(e.message);
        } finally {
            setBusy(false);
        }
    }

    async function runNow() {
        setBusy(true);
        setError(null);
        setNotice(null);
        try {
            await runAdminTriage();
            setNotice('Triage pass started…');
            await load();
            pollUntilDone();
        } catch (e) {
            setError(e.message);
        } finally {
            setBusy(false);
        }
    }

    async function adopt(task, settingKey, modelId) {
        if (!window.confirm(`Adopt ${modelId} as the live ${task} model?\n\nThis writes ${settingKey} through the standard settings path (audited) and re-keys the AI reuse tags - upcoming rows re-adjudicate under the new model, budget-bounded.`)) return;
        await setKnob(settingKey, modelId);
        setNotice(`${task} now routes to ${modelId}.`);
    }

    return (
        <div className="space-y-4 max-w-4xl">
            <Card
                title="Model triage"
                note={`Weekly OpenRouter catalog pull + qualification probes. Last run: ${fmtWhen(status.last_run_at)} · every ${status.interval_hours}h · probe budget ${status.probe_budget}/run.`}
                right={(
                    <button disabled={busy || status.running} onClick={runNow}
                        className="cursor-pointer h-8 px-3 shrink-0 rounded-lg bg-fill hover:bg-fill-hover text-label text-[12px] font-medium disabled:opacity-50">
                        {status.running ? 'Running…' : 'Run triage now'}
                    </button>
                )}
            >
                <div className="mt-3 flex flex-col sm:flex-row gap-3 sm:gap-8">
                    <label className="flex items-center gap-2 text-[12px] text-label-2">
                        <Switch checked={status.enabled} disabled={busy} onChange={v => setKnob('TRIAGE_ENABLED', v)} />
                        Weekly background triage
                    </label>
                    <label className="flex items-center gap-2 text-[12px] text-label-2"
                        title="Guardrails: one task per run, fully-qualified primaries only, never a blind/anchored vendor collision; every switch lands a dated admin_audit row.">
                        <Switch checked={status.auto_switch} disabled={busy} onChange={v => setKnob('TRIAGE_AUTO_SWITCH', v)} />
                        Auto-switch live routing (guard-railed)
                    </label>
                </div>
                {!status.openrouter_key && (
                    <p className="text-[11px] text-hot mt-2">OPENROUTER_API_KEY is unset - catalog pulls work but qualification probes are skipped, so no candidate can become PRIMARY.</p>
                )}
                <p className="text-[11px] text-label-3 mt-2">
                    Free-tier note: a one-time $10 OpenRouter credit top-up raises the free allowance from 50 to 1,000 requests/day - the highest-leverage spend available for the free-model slots.
                </p>
                {notice && <p className="text-[12px] text-hit mt-2">{notice}</p>}
                {error && <p className="text-[12px] text-miss mt-2" role="alert">{error}</p>}
            </Card>

            {!shortlist && (
                <Card title="No shortlist yet" note="Run a triage pass (button above) to pull the catalog and build the first per-task shortlist." />
            )}

            {events && (events.added?.length || events.delisted?.length || events.price_changed?.length) ? (
                <Card title="Catalog events" note="Changes since the previous snapshot (the models-API diff is the announcement ground truth).">
                    <div className="mt-2 space-y-1 text-[12px]">
                        {(events.delisted ?? []).map(m => (
                            <div key={`d${m.id}`} className="text-miss">− delisted: <code>{m.id}</code>
                                {Object.values(routing ?? {}).includes(m.id) && <Badge cls="bg-miss/10 text-miss ml-1.5">WAS LIVE - adopt a replacement</Badge>}
                            </div>
                        ))}
                        {(events.added ?? []).map(m => (
                            <div key={`a${m.id}`} className="text-hit">+ added: <code>{m.id}</code>{m.free ? ' (free)' : ''}</div>
                        ))}
                        {(events.price_changed ?? []).map(p => (
                            <div key={`p${p.id}`} className="text-label-2">~ repriced: <code>{p.id}</code> {perM(p.before?.prompt)} → {perM(p.after?.prompt)} /M in</div>
                        ))}
                    </div>
                </Card>
            ) : null}

            {shortlist && TASK_ORDER.filter(t => shortlist.tasks?.[t]).map(task => (
                <TaskCard key={task} task={task} data={shortlist.tasks[task]}
                    live={routing?.[task] ?? null} autoSwitch={status.auto_switch} busy={busy} onAdopt={adopt} />
            ))}
        </div>
    );
}
