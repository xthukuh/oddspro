import { useEffect } from 'react';

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
    // Escape closes; low-stakes modal so a backdrop click closes too.
    useEffect(() => {
        const onKey = e => e.key === 'Escape' && onClose();
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [onClose]);

    const embed = youtubeEmbed(DEMO_URL);

    return (
        <div
            onClick={onClose}
            className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/50 p-2 md:p-4"
        >
            <div
                onClick={e => e.stopPropagation()}
                className="bg-white rounded-lg shadow-xl w-full max-w-2xl max-h-[90vh] md:max-h-[85vh] flex flex-col p-4 md:p-6 text-slate-800"
            >
                <div className="flex items-center mb-3">
                    <h2 className="text-lg font-semibold">
                        <span className="rounded border border-slate-300 bg-slate-100 px-1.5 py-0.5 text-sm font-bold tracking-wide mr-2">[OP]</span>
                        {APP_NAME} — Help
                    </h2>
                    <div className="grow" />
                    <button onClick={onClose} title="Close" className="cursor-pointer text-slate-500 hover:text-slate-800 text-xl leading-none">&times;</button>
                </div>

                <div className="overflow-y-auto">
                    <p className="text-sm text-slate-600 mb-3">
                        <strong>{APP_NAME}</strong> is a football odds &amp; tips dashboard. It gathers
                        bookmaker odds (BetPawa, Betika) alongside official fixture and results data,
                        matches them up, and surfaces data-driven <strong>Over 2.5 hot picks</strong> 🔥
                        and best-bet <strong>tips</strong> ranked by a backtested confidence model.
                    </p>
                    <ul className="text-sm text-slate-600 mb-4 space-y-1 list-disc pl-5">
                        <li>Use the <strong>date navigation</strong> (⌂ ‹ ›) to browse fixtures by day.</li>
                        <li><strong>⟳ Refresh</strong> re-fetches odds, fixtures &amp; results for the selected date.</li>
                        <li><strong>✨ Magic</strong> re-orders tips most-likely-to-win first using backtested strategies.</li>
                        <li><strong>🧾 Slips</strong> builds virtual multi-bet slips from the day's tips.</li>
                        <li><strong>▽ Filters</strong> narrows the table; <strong>⚙ Settings</strong> controls columns &amp; display.</li>
                    </ul>

                    <h3 className="text-sm font-semibold mb-2">Demo video</h3>
                    <div className="relative w-full overflow-hidden rounded-lg bg-slate-900" style={{ aspectRatio: '16 / 9' }}>
                        {embed ? (
                            <iframe
                                className="absolute inset-0 w-full h-full"
                                src={embed}
                                title={`${APP_NAME} demo`}
                                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                                allowFullScreen
                            />
                        ) : (
                            <div className="absolute inset-0 flex flex-col items-center justify-center text-center text-slate-300 p-4">
                                <span className="text-4xl mb-2">▶</span>
                                <span className="text-sm">Demo video coming soon</span>
                                <span className="text-xs text-slate-400 mt-1">A walkthrough will be published here shortly.</span>
                            </div>
                        )}
                    </div>

                    <p className="text-xs text-slate-400 mt-4">
                        Maintained by <a className="underline hover:text-slate-600" href="https://github.com/xthukuh" target="_blank" rel="noreferrer">Martin Thuku</a>.
                    </p>
                </div>
            </div>
        </div>
    );
}
