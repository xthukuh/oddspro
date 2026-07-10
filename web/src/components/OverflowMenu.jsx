import { IconRefresh, IconSpinner, IconMagic, IconSlips, IconFilter, IconHelp, IconGear } from './icons.jsx';

// Right-justified mobile overflow: the toolbar actions as a simple tap list
// (date nav stays inline in the bar). Each row fires the same handler as its
// full-size button. Backdrop click closes.
function Row({ icon, label, onClick, disabled, active, trailing }) {
    return (
        <button onClick={onClick} disabled={disabled}
            className={`cursor-pointer w-full flex items-center gap-3 px-4 py-3 text-[15px] text-left hover:bg-fill disabled:opacity-40 ${active ? 'text-accent' : 'text-label'}`}>
            <span className="w-5 inline-flex justify-center">{icon}</span>
            <span className="flex-1">{label}</span>
            {trailing}
        </button>
    );
}

export default function OverflowMenu({ refreshing, canRefresh, filterCount, magicActive,
    onRefresh, onMagic, onSlips, onFilters, onHelp, onSettings, onClose }) {
    return (
        <>
            <div onClick={onClose} className="fixed inset-0 z-50" />
            <div className="absolute right-0 top-[46px] w-56 bg-surface text-label rounded-2xl shadow-2xl border border-separator-2 py-1 z-[60] [animation:op-pop_0.16s_ease]">
                <Row icon={refreshing ? <IconSpinner className="[animation:op-spin_0.8s_linear_infinite]" /> : <IconRefresh />}
                    label={refreshing ? 'Refreshing…' : 'Refresh'} onClick={onRefresh} disabled={!canRefresh} />
                <Row icon={<IconMagic />} label="Magic sort" onClick={onMagic} active={magicActive} />
                <Row icon={<IconSlips />} label="Betslip playground" onClick={onSlips} />
                <Row icon={<IconFilter />} label="Filters" onClick={onFilters} active={filterCount > 0}
                    trailing={filterCount ? <span className="text-xs tabular-nums text-label-2">{filterCount}</span> : null} />
                <div className="h-px bg-separator-2 my-1" />
                <Row icon={<IconHelp />} label="Help" onClick={onHelp} />
                <Row icon={<IconGear />} label="Display settings" onClick={onSettings} />
            </div>
        </>
    );
}
