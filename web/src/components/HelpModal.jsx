import { useState } from 'react';
import Sheet, { SheetClose, PinToggle } from './Sheet.jsx';

// Help / About modal: a brief, user-facing description of what Odds Pro does
// plus an embedded demo video. The video URL is configurable at build time via
// VITE_DEMO_VIDEO_URL (.env) - unset shows a "coming soon" placeholder so the
// modal is complete before the real tutorial is recorded/uploaded.

const APP_NAME = import.meta.env.VITE_APP_NAME || 'Odds Pro';
const DEMO_URL = import.meta.env.VITE_DEMO_VIDEO_URL || '';

// Accept any common YouTube URL form (watch / youtu.be / embed / shorts) and
// return a privacy-friendly embed URL, or null if it isn't a YouTube link.
function youtubeEmbed(url) {
    const m = /(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|v\/|shorts\/))([\w-]{11})/.exec(url || '');
    return m ? `https://www.youtube-nocookie.com/embed/${m[1]}?rel=0` : null;
}

export default function HelpModal({ onClose }) {
    const embed = youtubeEmbed(DEMO_URL);
    const [pinned, setPinned] = useState(false);

    return (
        <Sheet onClose={onClose} className="max-w-2xl" dismissable={!pinned}>
            <div className="flex flex-col max-h-[calc(100dvh-4.5rem)]">
                <div className="flex items-center gap-3 px-6 pt-5 pb-3">
                    <h2 className="text-[22px] font-extrabold tracking-tight flex items-center">
                        <span className="rounded-md border border-separator bg-fill px-1.5 py-0.5 text-sm font-bold tracking-wide mr-2">[OP]</span>
                        {APP_NAME} - Help
                    </h2>
                    <div className="flex-1" />
                    <PinToggle pinned={pinned} onToggle={() => setPinned(v => !v)} />
                    <SheetClose onClose={onClose} />
                </div>

                <div className="overflow-y-auto px-6 pb-6">
                    <p className="text-sm text-label-2 mb-3">
                        <strong className="text-label">{APP_NAME}</strong> is a football odds &amp; tips dashboard. It brings
                        bookmaker odds (BetPawa, Betika) together with official fixture and results data,
                        matches them up, and highlights the standout <strong className="text-label">Over 2.5 hot picks</strong> 🔥
                        and best-bet <strong className="text-label">tips</strong> for each day - ranked most-likely-to-win first.
                    </p>
                    <ul className="text-sm text-label-2 mb-4 space-y-1 list-disc pl-5">
                        <li>Use the <strong className="text-label">date navigation</strong> (‹ ›) and the calendar to browse fixtures by day; the logo returns you to today.</li>
                        <li><strong className="text-label">Refresh</strong> re-fetches odds, fixtures &amp; results for the selected date.</li>
                        <li><strong className="text-label">Magic</strong> re-orders tips so the strongest come first.</li>
                        <li><strong className="text-label">Slips</strong> builds virtual multi-bet slips from the day's tips.</li>
                        <li><strong className="text-label">Filters</strong> narrows the table; <strong className="text-label">Settings</strong> controls columns &amp; display.</li>
                    </ul>

                    <h3 className="text-sm font-semibold mb-2">Demo video</h3>
                    <div className="relative w-full overflow-hidden rounded-xl bg-slate-900" style={{ aspectRatio: '16 / 9' }}>
                        {embed ? (
                            <iframe
                                className="absolute inset-0 w-full h-full"
                                src={embed}
                                title={`${APP_NAME} demo`}
                                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                                allowFullScreen
                            />
                        ) : (
                            <div className="absolute inset-0 flex flex-col items-center justify-center text-center text-white/70 p-4">
                                <span className="text-4xl mb-2">▶</span>
                                <span className="text-sm">Demo video coming soon</span>
                                <span className="text-xs text-white/50 mt-1">A walkthrough will be published here shortly.</span>
                            </div>
                        )}
                    </div>

                    <p className="text-xs text-label-3 mt-4">
                        Maintained by <a className="underline hover:text-label" href="https://github.com/xthukuh" target="_blank" rel="noreferrer">Martin Thuku</a>.
                    </p>
                </div>
            </div>
        </Sheet>
    );
}
