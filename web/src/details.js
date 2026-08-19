import { useSession } from './auth/SessionProvider.jsx';

// SHOW_DETAILS - master switch for the app's "internal reasoning" surfaces:
// the TipPopover blend/weights/gate-audit/AI breakdown and the Magic-sort
// sheet's methodology (explainer prose + per-strategy backtest numbers).
//
// Baked in at BUILD time from VITE_SHOW_DETAILS (root .env, like the other VITE_* vars).
// DEFAULT ON - production hides the methodology (our edge) with
// VITE_SHOW_DETAILS=0; signed-in accounts are the "per-user" unlock.
export const showDetails = v => v !== '0' && v !== 'false';

export const SHOW_DETAILS = showDetails(import.meta.env.VITE_SHOW_DETAILS);

// Session-aware details gate (Phase 8, GUEST_PREMIUM extension): a guest
// sees the reasoning surfaces only when the server granted them premium
// access (GUEST_PREMIUM on) - mirroring the server, which only skips
// redacting their /api/records rows in that case (src/db/access-rules.js).
// Any signed-in user still qualifies via `premium`. One policy, one place;
// components read this instead of SHOW_DETAILS directly.
export function useShowDetails() {
    return SHOW_DETAILS && (useSession()?.premium ?? false);
}
