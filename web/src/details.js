import { useSession } from './auth/SessionProvider.jsx';

// SHOW_DETAILS - master switch for the app's "internal reasoning" surfaces:
// the TipPopover blend/weights/gate-audit/AI breakdown and the Magic-sort
// sheet's methodology (explainer prose + per-strategy backtest numbers).
//
// Baked in at BUILD time from VITE_SHOW_DETAILS (root .env, like VITE_HUMAN_POW).
// DEFAULT ON - production hides the methodology (our edge) with
// VITE_SHOW_DETAILS=0; signed-in accounts are the "per-user" unlock.
export const showDetails = v => v !== '0' && v !== 'false';

export const SHOW_DETAILS = showDetails(import.meta.env.VITE_SHOW_DETAILS);

// Session-aware details gate (Phase 8): guests never see the reasoning
// surfaces, whatever the build flag says - mirroring the server, which
// redacts their /api/records rows anyway (src/db/access-rules.js). One
// policy, one place; components read this instead of SHOW_DETAILS directly.
export function useShowDetails() {
    return SHOW_DETAILS && !(useSession()?.isGuest ?? false);
}
