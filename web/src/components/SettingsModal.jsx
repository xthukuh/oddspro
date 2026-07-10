import MultiSelect from './MultiSelect.jsx';
import ProviderPriority from './ProviderPriority.jsx';
import NumberInput from './NumberInput.jsx';
import DraggablePills from './DraggablePills.jsx';
import Sheet, { SheetClose } from './Sheet.jsx';
import { BASE_COLUMNS, applyOrder } from './DataTable.jsx';
import { THEMES } from '../theme.js';
import { DEFAULT_SAFE } from '../../../src/db/magic-rules.js';

// Display settings, organized into related sections:
//   Appearance  - theme (System / Light / Dark)
//   Columns     - market/stats multi-selects (day-dynamic) + drag-to-reorder
//   Sorting     - sort-priority drag list (same pill control as Column order)
//   Providers   - visible bookmakers + unavailable-link exceptions
//   View & tips - completed-games + settled-tip toggles + Safe-only + its limits

const THEME_LABEL = { system: 'System', light: 'Light', dark: 'Dark' };

// Segmented theme control (iOS-style). System is the default (follows the OS).
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
    return (
        <label className="flex items-center gap-2.5 text-sm cursor-pointer py-1.5" title={title}>
            <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} className="accent-accent h-4 w-4" />
            <span>{children}</span>
        </label>
    );
}

// One safe-limit number field seeded from the effective policy, defaulting the
// placeholder to the shipped DEFAULT_SAFE value.
function SafeLimit({ label, k, safe, onSafeSet, min, max, int, step, hint }) {
    return (
        <label className="flex flex-col gap-1 text-xs text-label-2" title={hint}>
            {label}
            <NumberInput
                value={safe?.[k] ?? DEFAULT_SAFE[k]}
                onCommit={n => onSafeSet(k, n)}
                min={min}
                max={max}
                int={int}
                step={step}
                className="w-20 bg-surface border border-separator text-label rounded-[10px] px-2 h-10 text-sm outline-none"
            />
        </label>
    );
}

export default function SettingsModal({
    catalog, theme, onTheme, availableMarkets, availableStats,
    marketKeys, statKeys, columnOrder, providers, providerItems, linkProviders, showCompleted,
    hideHits, hideMiss, noMiss, oneEach, safeOnly, safeMaxPerDay = 3,
    safe, safeDefaults, safeOverridden, onSafeSet, onSafeReset,
    sortChain, entryLabel, onReorderSort, onRemoveSort,
    onMarkets, onStats, onOrder, onToggleProvider, onMoveProvider, onLinkProviders, onShowCompleted,
    onHideHits, onHideMiss, onNoMiss, onOneEach, onSafeOnly, onClose,
}) {
    const statLabel = new Map(catalog.stats.map(c => [c.key, c.label]));
    const orderedColumns = applyOrder([
        ...BASE_COLUMNS,
        ...marketKeys.map(key => ({ key, label: key })),
        ...statKeys.map(key => ({ key, label: statLabel.get(key) ?? key })),
    ], columnOrder);
    const sortId = e => (e.type === 'magic' ? `magic:${e.id}` : `col:${e.key}`);

    const heading = 'font-semibold text-label mb-2';

    return (
        <Sheet onClose={onClose} className="max-w-2xl">
            <div className="flex flex-col max-h-[calc(100dvh-4.5rem)]">
                <div className="flex items-center gap-3 px-6 pt-5 pb-3">
                    <h2 className="text-[22px] font-extrabold tracking-tight">Display settings</h2>
                    <div className="flex-1" />
                    <SheetClose onClose={onClose} />
                </div>
                <div className="flex-1 min-h-0 overflow-y-auto px-6 pb-3">

                    <section className="mb-6">
                        <h3 className={heading}>Appearance</h3>
                        <ThemeToggle theme={theme} onTheme={onTheme} />
                        <p className="text-xs text-label-2 mt-1.5">System follows your device's light/dark setting.</p>
                    </section>

                    <section className="mb-6">
                        <h3 className={heading}>Columns</h3>
                        <div className="flex flex-wrap gap-2 mb-3">
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
                        </div>
                        <div className="flex items-center gap-3 mb-2">
                            <h4 className="text-sm text-label-2">Column order</h4>
                            <div className="grow" />
                            <button onClick={() => onOrder(null)} className="text-xs text-accent hover:opacity-70">
                                Reset order
                            </button>
                        </div>
                        <DraggablePills
                            items={orderedColumns}
                            idOf={c => c.key}
                            onReorder={next => onOrder(next.map(c => c.key))}
                        >
                            {(c, dragging) => (
                                <span
                                    className={`px-2.5 py-1.5 rounded-lg border text-xs bg-surface ${dragging
                                        ? 'border-accent' : 'border-separator hover:border-label-3'}`}
                                    title="Drag to reposition this column"
                                >
                                    <span className="text-label-3 mr-1">⠿</span>{c.label}
                                </span>
                            )}
                        </DraggablePills>
                        <p className="text-xs text-label-2 mt-2">
                            Only columns with data for the selected day are offered. Your picks are kept for
                            days that do have them.
                        </p>
                    </section>

                    {sortChain?.length > 0 && (
                        <section className="mb-6">
                            <div className="flex items-center gap-3 mb-2">
                                <h3 className="font-semibold text-label">Sort priority</h3>
                                <div className="grow" />
                                <span className="text-xs text-label-3">drag to reorder · left wins</span>
                            </div>
                            <DraggablePills
                                items={sortChain}
                                idOf={sortId}
                                onReorder={onReorderSort}
                            >
                                {(e, dragging) => {
                                    const i = sortChain.findIndex(x => sortId(x) === sortId(e));
                                    return (
                                        <span
                                            className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs bg-surface ${dragging
                                                ? 'border-accent' : 'border-separator'}`}
                                            title="Drag to change sort priority"
                                        >
                                            <span className="text-label-3">⠿</span>
                                            <span className="text-label-3 tabular-nums">{i + 1}</span>
                                            <span className="font-medium">{entryLabel(e)}</span>
                                            {e.type === 'column' && <span className="text-accent">{e.dir === 'asc' ? '▲' : '▼'}</span>}
                                            <button
                                                onPointerDown={ev => ev.stopPropagation()}
                                                onClick={() => onRemoveSort(e)}
                                                className="cursor-pointer text-label-3 hover:text-miss leading-none pl-0.5"
                                                title="Remove this sort"
                                            >
                                                &times;
                                            </button>
                                        </span>
                                    );
                                }}
                            </DraggablePills>
                        </section>
                    )}

                    <section className="mb-6">
                        <h3 className={heading}>Providers</h3>
                        <div className="flex flex-wrap gap-2 mb-2">
                            <ProviderPriority
                                label="Providers"
                                items={providerItems}
                                onToggle={onToggleProvider}
                                onMove={onMoveProvider}
                            />
                            <MultiSelect
                                label="Unavailable match links"
                                options={providers.map(p => ({ key: p, label: p }))}
                                selected={linkProviders}
                                onChange={onLinkProviders}
                                title="Keep clickable links for a provider's concluded / market-less matches"
                            />
                        </div>
                        <p className="text-xs text-label-2">
                            Tick a bookmaker to show it and use the arrows to set priority (top first). The
                            order picks which provider represents a game under <b>One of each</b>. Unavailable
                            matches (concluded, or no markets left) are unlinked by default — enable a provider
                            under links to keep them anyway (betpawa serves concluded pages for ~6h).
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
                            One of each <span className="text-label-3">— one row per game from your top provider; other providers fill any gaps</span>
                        </Toggle>

                        <h4 className="text-sm text-label-2 mt-3 mb-1">Settled tips</h4>
                        <div className="flex flex-col">
                            <Toggle checked={hideHits} onChange={onHideHits}
                                title="Hide tips that already won; keeps losing and upcoming tips.">
                                Hide hits <span className="text-label-3">— show only losing &amp; upcoming tips</span>
                            </Toggle>
                            <Toggle checked={hideMiss} onChange={onHideMiss}
                                title="Hide tips that already lost; keeps winning and upcoming tips.">
                                Hide miss <span className="text-label-3">— show only winning &amp; upcoming tips</span>
                            </Toggle>
                            <Toggle checked={noMiss} onChange={onNoMiss}
                                title="Drop every pick from any market that lost anywhere today; keeps clean markets' wins + upcoming.">
                                No miss <span className="text-label-3">— hide every pick from a market that lost anywhere today (keeps clean markets' wins + upcoming)</span>
                            </Toggle>
                            <Toggle checked={safeOnly} onChange={onSafeOnly}
                                title={`Only the day's safest slip legs: blend signals in agreement (none weak), short odds, best ${safeMaxPerDay} per day. Zero games = no safe bet exists.`}>
                                🛡 Safe only <span className="text-label-3">— only the day's safest slip legs: signals in agreement (none weak), short odds, best {safeMaxPerDay} per day. Zero games means no safe bet exists — the protocol working</span>
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
                            <div className="flex flex-wrap gap-3">
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
                <div className="flex justify-end px-6 py-3 border-t border-separator-2">
                    <button onClick={onClose} title="Close settings (changes are saved as you make them)" className="cursor-pointer h-11 px-6 rounded-full bg-accent text-white text-sm font-semibold hover:opacity-90">
                        Done
                    </button>
                </div>
            </div>
        </Sheet>
    );
}
