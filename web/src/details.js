// SHOW_DETAILS - master switch for the app's "internal reasoning" surfaces:
// the TipPopover blend/weights/gate-audit/AI breakdown and the Magic-sort
// sheet's methodology (explainer prose + per-strategy backtest numbers).
//
// Baked in at BUILD time from VITE_SHOW_DETAILS (root .env, like VITE_HUMAN_POW).
// DEFAULT ON - production hides the methodology (our edge) with
// VITE_SHOW_DETAILS=0; a premium tier can later flip it per-user.
export const showDetails = v => v !== '0' && v !== 'false';

export const SHOW_DETAILS = showDetails(import.meta.env.VITE_SHOW_DETAILS);
