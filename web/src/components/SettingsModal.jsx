import { useRef, useState } from 'react';
import MultiSelect from './MultiSelect.jsx';
import ReorderList from './ReorderList.jsx';
import NumberInput from './NumberInput.jsx';
import Field from './Field.jsx';
import Sheet, { SheetClose, PinToggle } from './Sheet.jsx';
import { BASE_COLUMNS, applyOrder } from './DataTable.jsx';
import { THEMES } from '../theme.js';
import { DEFAULT_SAFE } from '../../../src/db/magic-rules.js';
import { exportConfig, importConfig } from '../configSnapshot.js';

const APP_VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : null;

// Display settings, organized into related sections:
//   Appearance         - theme (System / Light / Dark)
//   Columns & sorting  - market/stats multi-selects (day-dynamic) + the Column
//                        order and Sort priority reorder dropdowns (ReorderList)
//   Providers          - provider priority (enable + ↑/↓ order) + unavailable-link exceptions
//   View & tips        - completed-games + One-of-each + settled-tip toggles + Safe-only + its limits
// Column order, Sort priority and Providers share the ONE ReorderList control.

const THEME_LABEL = { system: 'System', light: 'Light', dark: 'Dark' };

// Segmented theme control (iOS-style). Light is the default; System follows the OS.
function ThemeToggle({ theme, onTheme }) {
    return (
        <div className="inline-flex rounded-[10px] bg-fill p-0.5 gap-0.5">
            {THEMES.map(val => (
                <button
                    key={val}
                    onClick={() => onTheme(val)}
                    title={val === 'system' ? 'Match your device appearance' : `Always use ${THEME_LABEL[val].toLowerCase()} appearance`}
                    className={`cursor-pointer h-9 px-4 rounded-[8px] text-sm font-medium ${theme === val
                        ? 'bg-surface text-label shadow-sm' : 'text-label-2 hover:text-label'}`}
                >
                    {THEME_LABEL[val]}
                </button>
            ))}
        </div>
    );
}

// A checkbox row with a generous tap area. `title` gives it a hover tooltip.
function Toggle({ checked, onChange, title, children }) {
    // The whole row is one ≥44px tap target (AX5): tapping the label text -
    // not just the 16px box - flips it, comfortable on touch.
    return (
        <label className="flex items-center gap-2.5 text-sm cursor-pointer select-none min-h-[44px] py-1.5" title={title}>
            <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} className="accent-accent h-4 w-4 shrink-0" />
            <span>{children}</span>
        </label>
    );
}

// One safe-limit number field seeded from the effective policy, defaulting the
// placeholder to the shipped DEFAULT_SAFE value. Its hint is shown VISIBLY via
// Field (E1) - no hover-only title - so touch users get the guidance too.
function SafeLimit({ label, k, safe, onSafeSet, min, max, int, step, hint }) {
    return (
        <Field label={label} hint={hint}>
            <NumberInput
                value={safe?.[k] ?? DEFAULT_SAFE[k]}
                onCommit={n => onSafeSet(k, n)}
                min={min}
                max={max}
                int={int}
                step={step}
                className="w-full bg-surface border border-separator text-label rounded-[10px] px-2 h-10 text-sm outline-none"
            />
        </Field>
    );
}

export default function SettingsModal({
    catalog, theme, onTheme, availableMarkets, availableStats,
    marketKeys, statKeys, columnOrder, providers, providerItems, linkProviders, showCompleted,
    hideHits, hideMiss, noMiss, oneEach, safeOnly, safeMaxPerDay = 3,
    safe, safeDefaults, safeOverridden, onSafeSet, onSafeReset,
    sortChain, entryLabel, onReorderSort, onRemoveSort,
    baseColOptions = [], visibleBaseKeys, onVisibleBase, noPin, onNoPin,
    onMarkets, onStats, onOrder, onToggleProvider, onMoveProvider, onReorderProviders, onLinkProviders, onShowCompleted,
    onHideHits, onHideMiss, onNoMiss, onOneEach, onSafeOnly, onClose,
}) {
    const statLabel = new Map(catalog.stats.map(c => [c.key, c.label]));
    // The reorder list carries the shown, orderable columns: visible base + the
    // No row-number column + selected markets/stats (Select is always leftmost,
    // so it's excluded from ordering).
    const baseShown = key => !visibleBaseKeys || visibleBaseKeys.includes(key);
    const orderedColumns = applyOrder([
        ...[{ key: 'no', label: 'No' }, ...BASE_COLUMNS].filter(c => baseShown(c.key)),
        ...marketKeys.map(key => ({ key, label: key })),
        ...statKeys.map(key => ({ key, label: statLabel.get(key) ?? key })),
    ], columnOrder);
    const sortId = e => (e.type === 'magic' ? `magic:${e.id}` : `col:${e.key}`);
    // Swap an item with its neighbour (ReorderList ↑/↓ arrows). Returns the new
    // array, or null at a boundary.
    const _swap = (arr, key, dir, keyOf) => {
        const i = arr.findIndex(x => keyOf(x) === key);
        const j = i + dir;
        if (i < 0 || j < 0 || j >= arr.length) return null;
        const next = arr.slice();
        [next[i], next[j]] = [next[j], next[i]];
        return next;
    };
    const moveColumn = (key, dir) => {
        const next = _swap(orderedColumns, key, dir, c => c.key);
        if (next) onOrder(next.map(c => c.key));
    };
    const moveSort = (key, dir) => {
        const next = _swap(sortChain, key, dir, sortId);
        if (next) onReorderSort(next);
    };

    const heading = 'font-semibold text-label mb-2';
    const [pinned, setPinned] = useState(false);

    // Wipe every persisted Odds Pro preference on this device and reload (E5).
    // Confirmed first - this resets slips, selections, filters, columns, theme…
    const clearCacheReload = () => {
        const ok = window.confirm(
            'Clear all saved Odds Pro settings on this device and reload?\n\n'
            + 'This resets your betslips, row selections, filters, column choices, '
            + 'sort order and theme. It does not touch any data on the server.',
        );
        if (!ok) return;
        for (const k of Object.keys(localStorage)) if (k.startsWith('oddspro.')) localStorage.removeItem(k);
        location.reload();
    };

    // Config portability (.oddspro): export a gzip snapshot of every saved
    // preference; import replaces the whole config on this device and reloads.
    const fileRef = useRef(null);
    const [ioMsg, setIoMsg] = useState(null);
    const doExport = async () => {
        setIoMsg(null);
        try {
            const n = await exportConfig(APP_VERSION);
            setIoMsg({ ok: true, text: `Exported ${n} setting${n === 1 ? '' : 's'}.` });
        } catch (e) {
            setIoMsg({ ok: false, text: `Export failed: ${e.message}` });
        }
    };
    const onImportFile = async e => {
        const file = e.target.files?.[0];
        e.target.value = ''; // let the same file be re-picked later
        if (!file) return;
        const ok = window.confirm(
            `Import "${file.name}"?\n\nThis REPLACES all Odds Pro settings on this device `
            + '(betslips, filters, sorts, columns, theme…) and reloads the page.',
        );
        if (!ok) return;
        try {
            await importConfig(file);
            location.reload();
        } catch (err) {
            setIoMsg({ ok: false, text: `Import failed: ${err.message}` });
        }
    };

    return (
        <Sheet onClose={onClose} className="max-w-2xl" dismissable={!pinned}>
            <div className="flex flex-col max-h-[calc(100dvh-4.5rem)]">
                <div className="flex items-center gap-3 px-6 pt-5 pb-3">
                    <h2 className="text-[22px] font-extrabold tracking-tight">Display settings</h2>
                    <div className="flex-1" />
                    <PinToggle pinned={pinned} onToggle={() => setPinned(v => !v)} />
                    <SheetClose onClose={onClose} />
                </div>
                <div className="flex-1 min-h-0 overflow-y-auto px-6 pb-3">

                    <section className="mb-6">
                        <h3 className={heading}>Appearance</h3>
                        <ThemeToggle theme={theme} onTheme={onTheme} />
                        <p className="text-xs text-label-2 mt-1.5">System follows your device's light/dark setting.</p>
                    </section>

                    <section className="mb-6">
                        <h3 className={heading}>Columns &amp; sorting</h3>
                        <div className="flex flex-wrap gap-2">
                            <MultiSelect
                                label="Table columns"
                                options={baseColOptions}
                                selected={visibleBaseKeys ?? baseColOptions.map(o => o.key)}
                                onChange={onVisibleBase}
                                title="Show or hide the fixed columns (Start, Fixture, Score…) plus the Select checkbox and No row-number columns"
                            />
                            <MultiSelect
                                label="Odds markets"
                                options={catalog.markets}
                                availableKeys={availableMarkets}
                                selected={marketKeys}
                                onChange={onMarkets}
                                title="Pick which odds-market columns show in the table (only markets carried by the loaded day are listed)"
                            />
                            <MultiSelect
                                label="Stats"
                                options={catalog.stats}
                                availableKeys={availableStats}
                                selected={statKeys}
                                onChange={onStats}
                                title="Pick which post-match stat columns show (only stats present on the loaded day are listed)"
                            />
                            <ReorderList
                                label="Column order"
                                items={orderedColumns.map(c => ({ key: c.key, label: c.label }))}
                                onMove={moveColumn}
                                onReorder={keys => onOrder(keys)}
                                hint="Order the table columns left→right (↑ = further left). Type a row's number to jump it."
                                title="Reorder the table columns"
                                footer={(
                                    <button onClick={() => onOrder(null)} className="text-xs text-accent hover:opacity-70 py-0.5">
                                        Reset order
                                    </button>
                                )}
                            />
                            {sortChain?.length > 0 && (
                                <ReorderList
                                    label="Sort priority"
                                    items={sortChain.map(e => ({ key: sortId(e), label: entryLabel(e), entry: e }))}
                                    onMove={moveSort}
                                    onReorder={keys => onReorderSort(keys.map(k => sortChain.find(e => sortId(e) === k)).filter(Boolean))}
                                    onRemove={key => { const e = sortChain.find(x => sortId(x) === key); if (e) onRemoveSort(e); }}
                                    renderTag={it => (it.entry.type === 'column'
                                        ? <span className="text-accent text-xs">{it.entry.dir === 'asc' ? '▲' : '▼'}</span> : null)}
                                    hint="Top wins. ↑/↓ or type a number to reprioritise · × removes a sort."
                                    title="Reorder or remove the active sorts"
                                />
                            )}
                        </div>
                        <p className="text-xs text-label-2 mt-2">
                            Only columns with data for the selected day are offered; your picks are kept for
                            days that do have them. Sort priority also lives on the table's pills.
                        </p>
                        <Toggle checked={noPin} onChange={onNoPin}
                            title="Freeze the No column's numbers to each row's load position, so sorting or filtering doesn't renumber them.">
                            Pin position numbers <span className="text-label-3">- freeze the No column so re-sorting doesn't renumber</span>
                        </Toggle>
                    </section>

                    <section className="mb-6">
                        <h3 className={heading}>Providers</h3>
                        <div className="flex flex-wrap gap-2 mb-2">
                            <ReorderList
                                label="Providers"
                                items={providerItems}
                                badge={`${providerItems.filter(i => i.enabled).length}/${providerItems.length}`}
                                onToggle={onToggleProvider}
                                onMove={onMoveProvider}
                                onReorder={onReorderProviders}
                                hint="Priority top→bottom. Untick to hide a bookmaker. Type a row's number to jump it."
                                title="Enable bookmakers and set their priority - the top enabled provider represents each game under One of each"
                            />
                            <MultiSelect
                                label="Keep links after kickoff"
                                options={providers.map(p => ({ key: p, label: p }))}
                                selected={linkProviders}
                                onChange={onLinkProviders}
                                title="Keep a provider's links clickable after kickoff / once markets close (e.g. betpawa serves live & concluded pages). Others auto-disable when the match starts."
                            />
                        </div>
                        <p className="text-xs text-label-2">
                            Tick a bookmaker to show it and use the arrows to set priority (top first). The
                            order picks which provider represents a game under <b>One of each</b>. A match link
                            auto-disables once it kicks off, is concluded, or has no markets left (many books,
                            e.g. Betika, drop the link at kickoff) - enable a provider under links to keep them
                            anyway (betpawa serves live &amp; concluded pages ~6h).
                        </p>
                    </section>

                    <section className="mb-5">
                        <h3 className={heading}>View &amp; tips</h3>
                        <Toggle checked={showCompleted} onChange={onShowCompleted}
                            title="Include games that have already finished. Untick to see upcoming matches only.">
                            Show completed games
                        </Toggle>
                        <p className="text-xs text-label-2 mt-0.5 mb-1">Untick to see upcoming matches only.</p>

                        <Toggle checked={oneEach} onChange={onOneEach}
                            title="Show one row per game, taken from your highest-priority enabled provider. Games only another provider carries still appear, so providers complement each other.">
                            One of each <span className="text-label-3">- one row per game from your top provider; other providers fill any gaps</span>
                        </Toggle>

                        <p className="text-xs text-label-3 mt-2">
                            With-selected actions (hide, keep, invert, export CSV…) now live in the ☑ column header menu at the top-left of the table.
                        </p>

                        <h4 className="text-sm text-label-2 mt-3 mb-1">Settled tips</h4>
                        <div className="flex flex-col">
                            <Toggle checked={hideHits} onChange={onHideHits}
                                title="Hide tips that already won; keeps losing and upcoming tips.">
                                Hide hits <span className="text-label-3">- show only losing &amp; upcoming tips</span>
                            </Toggle>
                            <Toggle checked={hideMiss} onChange={onHideMiss}
                                title="Hide tips that already lost; keeps winning and upcoming tips.">
                                Hide miss <span className="text-label-3">- show only winning &amp; upcoming tips</span>
                            </Toggle>
                            <Toggle checked={noMiss} onChange={onNoMiss}
                                title="Drop every pick from any market that lost anywhere today; keeps clean markets' wins + upcoming.">
                                No miss <span className="text-label-3">- hide every pick from a market that lost anywhere today (keeps clean markets' wins + upcoming)</span>
                            </Toggle>
                            <Toggle checked={safeOnly} onChange={onSafeOnly}
                                title={`Only the day's safest slip legs: blend signals in agreement (none weak), short odds, best ${safeMaxPerDay} per day. Zero games = no safe bet exists.`}>
                                🛡 Safe only <span className="text-label-3">- only the day's safest slip legs: signals in agreement (none weak), short odds, best {safeMaxPerDay} per day. Zero games means no safe bet exists - the protocol working</span>
                            </Toggle>
                        </div>

                        <div className="mt-3 rounded-xl border border-separator-2 p-3">
                            <div className="flex items-center gap-3 mb-2">
                                <h4 className="text-sm text-label-2">🛡 Safe-only limits</h4>
                                <div className="grow" />
                                <button
                                    onClick={onSafeReset}
                                    disabled={!safeOverridden}
                                    title="Discard your Safe-limit overrides and use the server policy"
                                    className="text-xs text-accent hover:opacity-70 disabled:opacity-40 disabled:hover:opacity-40"
                                >
                                    Reset to defaults
                                </button>
                            </div>
                            <div className="grid grid-cols-2 gap-x-4 gap-y-3">
                                <SafeLimit label="Max per day" k="maxPerDay" safe={safe} onSafeSet={onSafeSet}
                                    min={1} max={20} int hint="Cap the number of safe picks kept per day" />
                                <SafeLimit label="Max price" k="maxPrice" safe={safe} onSafeSet={onSafeSet}
                                    min={1} max={5} hint="Only keep short-priced legs at or below this odds" />
                                <SafeLimit label="Min agreement" k="minAgreement" safe={safe} onSafeSet={onSafeSet}
                                    min={0} max={1} step={0.05} hint="Floor on the weakest present blend component (0–1)" />
                                <SafeLimit label="Min signals" k="minParts" safe={safe} onSafeSet={onSafeSet}
                                    min={1} max={3} int hint="Require at least this many blend components present" />
                            </div>
                            <p className="text-xs text-label-2 mt-2">
                                Tighter limits = fewer, safer picks. Defaults come from the server policy
                                {safeDefaults ? '' : ' (loading…)'}; these tune it just for your view.
                            </p>
                        </div>

                        <p className="text-xs text-label-2 mt-2">
                            Ticking both Hide hits and Hide miss shows upcoming/ongoing games only. These
                            read best with Show completed on.
                        </p>
                    </section>

                </div>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-6 py-3 border-t border-separator-2">
                    <button
                        onClick={clearCacheReload}
                        title="Reset every saved preference on this device (slips, selections, filters, columns, theme) and reload. Server data is untouched."
                        className="cursor-pointer text-xs text-miss/80 hover:text-miss"
                    >
                        Clear cache &amp; reload
                    </button>
                    <span className="text-separator-2" aria-hidden="true">|</span>
                    <button
                        onClick={doExport}
                        title="Download a .oddspro snapshot of all your settings, betslips, filters, sorts and columns - to move your setup to another device or app instance."
                        className="cursor-pointer text-xs text-accent hover:opacity-70"
                    >
                        Export config
                    </button>
                    <button
                        onClick={() => fileRef.current?.click()}
                        title="Load a .oddspro snapshot. This REPLACES all settings on this device and reloads."
                        className="cursor-pointer text-xs text-accent hover:opacity-70"
                    >
                        Import config
                    </button>
                    <input ref={fileRef} type="file" accept=".oddspro,application/gzip" className="hidden" onChange={onImportFile} />
                    {ioMsg && <span className={`text-xs ${ioMsg.ok ? 'text-label-2' : 'text-miss'}`}>{ioMsg.text}</span>}
                    <div className="grow" />
                    <button onClick={onClose} title="Close settings (changes are saved as you make them)" className="cursor-pointer h-11 px-6 rounded-full bg-accent text-white text-sm font-semibold hover:opacity-90">
                        Done
                    </button>
                </div>
            </div>
        </Sheet>
    );
}
