// Theme-adaptive brand mark: [OP] filled via --logo (purple on light, white
// on dark).
//
// OP_MARK is the standalone centered mark (no button, no home nav) used by the
// auth shell + admin panel. It moved here 2026-07-16 when web/src/HumanGate.jsx
// was retired with the rest of the proof-of-work gate - it was never PoW
// specific, and this module already owned the same artwork. The two call sites
// keep their exact original dimensions, so nothing shifts visually.
function OpSvg({ width, height, className }) {
    return (
        <svg width={width} height={height} viewBox="0 0 63.601238 34.068436" role="img"
             aria-label="Odds Pro" fill="var(--logo)" className={className}>
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
}

export const OP_MARK = <OpSvg width={60} height={32} className="mx-auto" />;

// Home button - resets the table to today (SPA nav, no reload).
export default function Logo({ onHome }) {
    return (
        <button
            onClick={onHome}
            title="Odds Pro - home (today)"
            aria-label="Odds Pro home"
            className="cursor-pointer inline-flex items-center h-10 px-1.5 rounded-[10px] hover:bg-accent-soft"
        >
            <OpSvg width={52} height={28} />
        </button>
    );
}
