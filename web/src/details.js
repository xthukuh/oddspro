import { useSession } from './auth/SessionProvider.jsx';

// Premium-surface gates for the SPA. The decision itself lives ONCE, in the
// pure registry the server gates on (src/db/feature-rules.js, imported
// verbatim here - the magic-rules idiom), so the browser can never disagree
// with the payload it was sent. The server stays authoritative: these hooks
// only decide what to RENDER; /api/records already redacts what a tier may
// not have.
//
// Toggling a surface later = change its minTier in feature-rules.js, or name
// it in the GUEST_PREMIUM_EXCEPT setting for a no-deploy clawback.

// VITE_SHOW_DETAILS: a build-time HARD override kept for local/demo builds
// that want the reasoning surfaces off regardless of policy. It is NOT the
// premium gate any more - a `0` build used to hide the tip blend, runners-up
// and methodology from EVERY viewer including signed-in accounts, which is
// what silently hid them in production. Default (unset) = defer to the
// registry.
export const showDetails = v => v !== '0' && v !== 'false';
export const SHOW_DETAILS = showDetails(import.meta.env.VITE_SHOW_DETAILS);

// Is this session allowed one registry feature? The map is resolved once in
// SessionProvider from featureMap(), so an unknown key reads as undefined and
// fails CLOSED (hidden), never open.
export function useFeature(feature) {
    const s = useSession();
    return SHOW_DETAILS && Boolean(s?.features?.[feature]);
}

// The tip-reasoning surfaces: TipPopover's blend/weights, the over-2.5 gate
// audit and the AI double-check. (Runners-up and the per-market honesty line
// are NOT gated here - they render for every viewer whose row carries them.)
export function useShowDetails() {
    return useFeature('tip_reasoning');
}

// The magic-sort methodology: explainer prose + per-strategy backtest numbers.
export function useShowMethodology() {
    return useFeature('methodology');
}
