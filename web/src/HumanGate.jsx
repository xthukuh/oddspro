import { useEffect, useRef, useState } from 'react';
import { fetchChallenge, submitHuman } from './api.js';
import { solveChallenge } from './humanPow.js';
import { getHumanToken, setHumanToken } from './humanToken.js';

// Proof-of-work "verify you're human" gate. Rendered around <App/> only when the
// build sets VITE_HUMAN_POW (main.jsx). On mount it reuses a stored check-once
// token if one is still valid; otherwise it fetches a challenge, solves it in
// the browser (web/src/humanPow.js), and exchanges the solution for a token.
// Fail-safe: if the challenge endpoint is absent (server not enforcing), it
// lets the app through rather than locking anyone out on a config mismatch -
// the real protection is the server-side /api gate either way.
const OP_MARK = (
    <svg width="60" height="32" viewBox="0 0 63.601238 34.068436" role="img" aria-label="Odds Pro" fill="var(--logo)" className="mx-auto">
        <text x="31.834799" y="19.334578" textAnchor="middle" dominantBaseline="central"
              fontFamily="-apple-system, Arial, sans-serif" fontWeight="700" fontSize="28" letterSpacing="-1">OP</text>
        <g transform="translate(-0.11252066,-8.3910561)">
            <text x="6.725812" y="24.865044" textAnchor="middle" dominantBaseline="central"
                  fontFamily="-apple-system, Arial, sans-serif" fontWeight="700" fontSize="30" letterSpacing="-1">[</text>
            <text x="57.100468" y="24.865044" textAnchor="middle" dominantBaseline="central"
                  fontFamily="-apple-system, Arial, sans-serif" fontWeight="700" fontSize="30" letterSpacing="-1">]</text>
        </g>
    </svg>
);

export default function HumanGate({ children }) {
    const [done, setDone] = useState(() => Boolean(getHumanToken()));
    const [error, setError] = useState(null);
    const runningRef = useRef(false);

    async function verify() {
        if (runningRef.current) return;
        runningRef.current = true;
        setError(null);
        try {
            const challenge = await fetchChallenge();
            const nonce = await solveChallenge(challenge);
            const { token, ttl_days } = await submitHuman({ ...challenge, nonce });
            setHumanToken(token, ttl_days);
            setDone(true);
        } catch (e) {
            // Server isn't enforcing the gate (endpoint missing) -> don't block.
            if (/\b404\b|Cannot GET/i.test(e?.message || '')) {
                setDone(true);
            } else {
                setError(e?.message || 'Verification failed.');
            }
        } finally {
            runningRef.current = false;
        }
    }

    useEffect(() => {
        if (!done) verify();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    if (done) return children;

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-surface px-6">
            <div className="w-full max-w-xs text-center">
                <div className="mb-6">{OP_MARK}</div>
                {error ? (
                    <>
                        <p className="text-label text-sm font-semibold">Could not verify your browser</p>
                        <p className="text-label/60 text-xs mt-1.5 mb-5 break-words">{error}</p>
                        <button onClick={verify}
                                className="cursor-pointer rounded-lg bg-accent px-5 py-2 text-white text-sm font-medium hover:opacity-90">
                            Try again
                        </button>
                    </>
                ) : (
                    <>
                        <div className="mx-auto mb-4 h-6 w-6 animate-spin rounded-full border-2 border-accent border-t-transparent" />
                        <p className="text-label text-sm font-semibold">Verifying you&rsquo;re human</p>
                        <p className="text-label/60 text-xs mt-1.5">One moment while we check your browser.</p>
                    </>
                )}
            </div>
        </div>
    );
}
