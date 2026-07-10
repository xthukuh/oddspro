import { useState } from 'react';
import { IconChevronLeft, IconChevronRight } from './icons.jsx';

// Custom month-grid date picker (replaces the native <input type=date>): noon-
// anchored math dodges the UTC day-shift; out-of-range days are disabled;
// Clear -> All dates, Today -> today. Writes back through onPick(iso|'').

const WD = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const iso = d => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const prevMonth = v => (v.m === 0 ? { y: v.y - 1, m: 11 } : { y: v.y, m: v.m - 1 });
const nextMonth = v => (v.m === 11 ? { y: v.y + 1, m: 0 } : { y: v.y, m: v.m + 1 });

export default function CalendarPopover({ date, today, min, max, onPick, onClose }) {
    const anchor = date ? new Date(`${date}T12:00:00`) : new Date(`${today}T12:00:00`);
    const [view, setView] = useState({ y: anchor.getFullYear(), m: anchor.getMonth() });
    const first = new Date(view.y, view.m, 1);
    const days = Array.from({ length: 42 }, (_, i) => new Date(view.y, view.m, 1 - first.getDay() + i, 12));
    const title = first.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    const cell = d => {
        const s = iso(d);
        return { s, n: d.getDate(), inMonth: d.getMonth() === view.m, disabled: s < min || s > max, selected: s === date };
    };
    return (
        <>
            <div onClick={onClose} className="fixed inset-0 z-50" />
            <div className="absolute top-[54px] left-1/2 -translate-x-1/2 w-[300px] bg-surface text-label rounded-2xl shadow-2xl border border-separator-2 p-4 z-[60] [animation:op-pop_0.16s_ease]">
                <div className="flex items-center justify-between mb-3">
                    <div className="text-base font-bold">{title}</div>
                    <div className="flex gap-0.5">
                        <button onClick={() => setView(v => ({ ...v, ...prevMonth(v) }))} aria-label="Previous month"
                            className="cursor-pointer w-8 h-8 rounded-lg text-accent inline-flex items-center justify-center hover:bg-accent-soft"><IconChevronLeft width="8" height="14" /></button>
                        <button onClick={() => setView(v => ({ ...v, ...nextMonth(v) }))} aria-label="Next month"
                            className="cursor-pointer w-8 h-8 rounded-lg text-accent inline-flex items-center justify-center hover:bg-accent-soft"><IconChevronRight width="8" height="14" /></button>
                    </div>
                </div>
                <div className="grid grid-cols-7 gap-0.5 mb-1">
                    {WD.map((w, i) => <div key={i} className="text-center text-[11px] font-semibold text-label-3 py-1">{w}</div>)}
                </div>
                <div className="grid grid-cols-7 gap-0.5">
                    {days.map((d, i) => { const c = cell(d); return (
                        <button key={i} disabled={c.disabled} onClick={() => { onPick(c.s); onClose(); }}
                            className={`cursor-pointer h-10 rounded-lg text-sm tabular-nums ${c.selected ? 'bg-accent text-white font-semibold' : c.inMonth ? 'text-label hover:bg-accent-soft' : 'text-label-3 hover:bg-accent-soft'} disabled:opacity-30 disabled:hover:bg-transparent disabled:cursor-default`}>
                            {c.n}
                        </button>
                    ); })}
                </div>
                <div className="flex justify-between mt-3 pt-2.5 border-t border-separator-2">
                    <button onClick={() => { onPick(''); onClose(); }} className="cursor-pointer text-accent text-[15px] py-1.5 px-2 -mx-2 rounded-lg hover:bg-accent-soft">Clear</button>
                    <button onClick={() => { onPick(today); onClose(); }} className="cursor-pointer text-accent text-[15px] font-semibold py-1.5 px-2 -mx-2 rounded-lg hover:bg-accent-soft">Today</button>
                </div>
            </div>
        </>
    );
}
