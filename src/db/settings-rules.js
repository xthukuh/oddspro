// Pure dynamic-settings rules (offline-testable). Defines the CURATED catalog
// of operational knobs an admin may override at runtime, and the coerce/
// validate/merge helpers. Everything NOT in the catalog (secrets, DB creds,
// VITE_* build vars, host/port, AUTH_ENABLED - flipping the session system
// from inside a session could lock the admin out) is off-limits by
// construction. The service layer (src/settings.js) reads overrides late
// (like magic.js#safePolicy) and merges them over the immutable config
// defaults.
//
// Per-entry flags:
//   public  - shipped to the browser via GET /api/settings (NEVER a secret)
//   live    - an override takes effect without a server restart (its consumer
//             late-reads via settings.effective); live:false needs a restart
//             (read once at boot / middleware registration / scheduler start).
//   label   - short human name for the M7 editor row (REQUIRED on every entry)
//   hint    - one-sentence explanation for the M7 editor row (REQUIRED)
//   unit    - display unit chip (min/days/odds/KB/...) - optional
//   regime  - POLICY-REGIME knob (M6, spec decision 3): changing it changes
//             which picks/verdicts get GENERATED, splitting the settled ledger
//             into two populations (the TIP_MIN_PRICE 1.20->1.35 lesson,
//             docs/research/emergence-patterns-findings.md). The editor shows
//             an amber warning; every change lands a dated admin_audit row -
//             this trail REPLACES the manual memory-bank dated-note
//             discipline. Applied to TIP_*/HOTPICK_*/SAFE_* and the DARK AI
//             switches; HOTPICK_AI_CONCURRENCY is exempt (mechanical
//             throughput - it cannot change what gets generated).
//   pattern - regex SOURCE STRING a string value must fully match (kept as a
//             string, not a RegExp, so the entry JSON-serializes to the admin
//             editor unchanged). patternHint names the expected format in the
//             validation error.

import { z } from 'zod';
import { STRATEGIES } from './magic-rules.js'; // pure (perf-rules only) - same import config.js already makes

// PUT /api/admin/settings body envelope (C2 - external data through zod like
// the sibling auth routes): either { key, value } or { overrides: {...} }.
// Values stay z.unknown() - the real per-key validation is validateSettings
// against the catalog below; this schema only pins the request shape.
export const settingsPutSchema = z.object({
    key: z.string().min(1).optional(),
    value: z.unknown().optional(),
    overrides: z.record(z.unknown()).optional(),
}).refine(d => d.overrides != null || d.key != null, { message: 'Provide { key, value } or { overrides }' });

const STRATEGY_IDS = STRATEGIES.map(s => s.id);

// Reusable pattern sources (validation error shows patternHint).
const P_TIME = '^$|^off$|^([01]?\\d|2[0-3]):[0-5]\\d$';
const P_LINES_CSV = '^\\s*\\d+(\\.\\d+)?(\\s*,\\s*\\d+(\\.\\d+)?)*\\s*$';
const P_TIERS = '^$|^off$|^\\s*(\\*|\\d+)\\s*:\\s*\\d+(\\s*,\\s*(\\*|\\d+)\\s*:\\s*\\d+)*\\s*$';

export const SETTINGS_CATALOG = [
    // ---- Safe-only slip selection (public: shipped via /api/magic-sort +
    // /api/settings so server and client can never diverge). Every gate here
    // changes WHICH picks enter the safe pool -> regime.
    { key: 'SAFE_STRATEGY', type: 'string', group: 'safe', public: true, live: true, regime: true, enum: STRATEGY_IDS, label: 'Safe ranking strategy', hint: 'Magic strategy that ranks each day\'s safe-pool candidates before the per-day cap.' },
    { key: 'SAFE_MIN_PARTS', type: 'int', group: 'safe', public: true, live: true, regime: true, min: 1, max: 3, label: 'Safe: min blend parts', hint: 'A tip must blend at least this many evidence components (market/stats/API) to qualify.' },
    { key: 'SAFE_MIN_AGREEMENT', type: 'number', group: 'safe', public: true, live: true, regime: true, min: 0, max: 1, label: 'Safe: min agreement', hint: 'The weakest blend component (tip agreement) must be at least this probability.' },
    { key: 'SAFE_MAX_PRICE', type: 'number', group: 'safe', public: true, live: true, regime: true, min: 1, unit: 'odds', label: 'Safe: max price', hint: 'Odds ceiling for a safe pick - longer prices are excluded.' },
    { key: 'SAFE_MAX_PER_DAY', type: 'int', group: 'safe', public: true, live: true, regime: true, min: 1, unit: 'picks', label: 'Safe: picks per day', hint: 'Daily cap on safe-pool selections.' },
    { key: 'SAFE_MIN_SAMPLES', type: 'int', group: 'safe', public: true, live: true, regime: true, min: 0, unit: 'games', label: 'Safe: min team samples', hint: 'Rolling-form sample floor per side (stats-sufficiency gate); 0 = gate off.' },
    { key: 'SAFE_MIN_H2H', type: 'int', group: 'safe', public: true, live: true, regime: true, min: 0, unit: 'games', label: 'Safe: min H2H meetings', hint: 'Head-to-head sample floor (stats-sufficiency gate); 0 = gate off.' },
    { key: 'SAFE_MIN_MARKET_SETTLED', type: 'int', group: 'safe', public: true, live: true, regime: true, min: 0, unit: 'tips', label: 'Safe: market maturity floor', hint: 'A market needs at least this many settled live tips before it may enter the safe pool; 0 = off.' },
    // ---- Refresh cadence / cooldowns - late-read at call time / per tick.
    { key: 'REFRESH_COOLDOWN_MINUTES', type: 'number', group: 'refresh', public: false, live: true, min: 0, unit: 'min', label: 'Manual refresh cooldown', hint: 'Blocks re-triggering the SAME date until this long after its last run finished; 0 = off.' },
    { key: 'REFRESH_CACHE_MINUTES', type: 'number', group: 'refresh', public: false, live: true, min: 0, unit: 'min', label: 'Refresh freshness window', hint: 'A manual refresh answers "fresh" (no re-run) when the date was refreshed within this window; 0 = off.' },
    { key: 'AUTO_LIGHT_MINUTES', type: 'int', group: 'refresh', public: false, live: true, min: 0, unit: 'min', label: 'Light pass cadence', hint: 'Scores + today\'s odds + link every N minutes; 0 = light mode off.' },
    { key: 'AUTO_FULL_DAYS', type: 'int', group: 'refresh', public: false, live: true, min: 0, unit: 'days', label: 'Daily sweep lookahead', hint: 'How many days ahead the daily full sweep fetches.' },
    { key: 'ODDS_REFRESH_TIERS', type: 'string', group: 'refresh', public: false, live: true, pattern: P_TIERS, patternHint: 'CSV of upToMin:maxAgeMin tiers, * catch-all, or off', label: 'Odds detail backoff', hint: 'Kickoff-proximity tiers for light-pass odds detail fetches (upToMin:maxAgeMin CSV, * = catch-all); off/blank = never skip.' },
    { key: 'AUTO_IDLE_LOOKAHEAD_MINUTES', type: 'int', group: 'refresh', public: false, live: true, min: 0, unit: 'min', label: 'Idle lookahead', hint: 'Skip the light odds+link scrape when nothing is in-play and the next kickoff is farther out than this; 0 = off.' },
    { key: 'AUTO_IDLE_EVERY_MINUTES', type: 'int', group: 'refresh', public: false, live: true, min: 0, unit: 'min', label: 'Idle discovery cadence', hint: 'While idle, still run the scrape every N minutes so newly published games are discovered; 0 = never force.' },
    // Read once when the scheduler starts -> restart required.
    { key: 'AUTO_REFRESH_ENABLED', type: 'boolean', group: 'refresh', public: false, live: false, label: 'Auto-refresh scheduler', hint: 'Master switch for the in-process scheduler (light passes + daily full sweep). Restart to apply.' },
    { key: 'AUTO_FULL_AT', type: 'string', group: 'refresh', public: false, live: false, pattern: P_TIME, patternHint: 'HH:mm (EAT), off, or blank', label: 'Daily full sweep time', hint: 'EAT wall-clock time for the daily full pipeline; off/blank disables. Restart to apply.' },
    // ---- Pipeline / ingestion floors (M6).
    { key: 'APISPORTS_MIN_REMAINING', type: 'int', group: 'pipeline', public: false, live: true, min: 0, unit: 'requests', label: 'API-Football quota floor', hint: 'Halt API-Football fetching when the daily quota remaining drops to this floor.' },
    { key: 'LINK_MIN_CONFIDENCE', type: 'number', group: 'pipeline', public: false, live: true, min: 0, max: 1, label: 'Link confidence floor', hint: 'Minimum fuzzy-match score to correlate a bookmaker match to a fixture (plus the 0.05 runner-up margin).' },
    { key: 'PREMATCH_TEAM_WINDOW', type: 'int', group: 'pipeline', public: false, live: true, min: 1, unit: 'games', label: 'Prematch team window', hint: 'Rolling last-N window for per-team snapshot aggregates.' },
    { key: 'PREMATCH_H2H_WINDOW', type: 'int', group: 'pipeline', public: false, live: true, min: 1, unit: 'games', label: 'Prematch H2H window', hint: 'Last-N head-to-head meetings used in snapshot aggregates.' },
    // ---- Hot-pick gates (M6) - every one changes which picks FIRE -> regime.
    // Team window capped at 8: the history backfill only ever fetches 10
    // games/team, so a larger window silently under-fills its own sample.
    { key: 'HOTPICK_TEAM_WINDOW', type: 'int', group: 'hotpick', public: false, live: true, regime: true, min: 1, max: 8, unit: 'games', label: 'Hot: team window', hint: 'Rolling last-N games per side for the over-goals gates (max 8 - history backfill depth).' },
    { key: 'HOTPICK_MIN_GAMES', type: 'int', group: 'hotpick', public: false, live: true, regime: true, min: 1, unit: 'games', label: 'Hot: min games per side', hint: 'Both teams need at least this many qualifying games before the gates may fire.' },
    { key: 'HOTPICK_MIN_OVER_RATE', type: 'number', group: 'hotpick', public: false, live: true, regime: true, min: 0, max: 1, label: 'Hot: min over rate', hint: 'Both teams\' rolling over-line rate must reach this floor.' },
    { key: 'HOTPICK_MIN_AVG_TOTAL', type: 'number', group: 'hotpick', public: false, live: true, regime: true, min: 0, unit: 'goals', label: 'Hot: min avg total', hint: 'Both teams\' rolling average total goals must reach this floor.' },
    { key: 'HOTPICK_MIN_IMPLIED_OVER', type: 'number', group: 'hotpick', public: false, live: true, regime: true, min: 0, max: 1, label: 'Hot: min market P(over)', hint: 'Vig-removed market probability of the over must reach this floor.' },
    { key: 'HOTPICK_H2H_MIN_OVER_RATE', type: 'number', group: 'hotpick', public: false, live: true, regime: true, min: 0, max: 1, label: 'Hot: H2H veto floor', hint: 'A head-to-head over-rate below this vetoes the pick.' },
    { key: 'HOTPICK_LINES', type: 'string', group: 'hotpick', public: false, live: true, regime: true, pattern: P_LINES_CSV, patternHint: 'CSV of O/U lines, e.g. 2.5 or 1.5,2.5', label: 'Hot O/U lines', hint: 'O/U lines the evaluator scores; only lines with tuned thresholds (today 2.5) can actually fire hot.' },
    // ---- Tip candidacy floors + book-integrity guards (M6) -> regime.
    // TIP_MIN_PRICE moving 1.20->1.35 mid-window is the canonical ledger-split
    // lesson - the audit trail dates every change for mine-patterns.
    { key: 'TIP_MIN_PRICE', type: 'number', group: 'tip', public: false, live: true, regime: true, min: 1, unit: 'odds', label: 'Tip: min price', hint: 'Excludes near-certain junk odds below this floor from tip candidacy.' },
    { key: 'TIP_MIN_CONFIDENCE', type: 'number', group: 'tip', public: false, live: true, regime: true, min: 0, max: 1, label: 'Tip: min confidence', hint: 'Blend-confidence floor a candidate needs to become the fixture\'s tip.' },
    { key: 'TIP_MIN_UNDER_LINE', type: 'number', group: 'tip', public: false, live: true, regime: true, min: 0, unit: 'line', label: 'Tip: min Under line', hint: 'No Under tips below this line (near-Unders realized 61.9% vs 78.1% break-even).' },
    { key: 'TIP_MIN_OVERROUND', type: 'number', group: 'tip', public: false, live: true, regime: true, label: 'Tip book: min overround', hint: 'Family-book integrity floor - a book under 1.0 smells like a palpable error or boosted price.' },
    { key: 'TIP_MAX_OVERROUND', type: 'number', group: 'tip', public: false, live: true, regime: true, label: 'Tip book: max overround', hint: 'Family-book ceiling - heavy margin loading ruins the devig.' },
    { key: 'TIP_MAX_BOOK_DIVERGENCE', type: 'number', group: 'tip', public: false, live: true, regime: true, label: 'Tip book: max divergence', hint: 'Cross-provider devigged-probability divergence veto for the M3 families.' },
    // ---- AI enrichment + review worker. Model/grounding switches re-key the
    // verdict/insight reuse tags (a bounded re-bill wave) -> regime on the
    // adjudicator-facing knobs; concurrency alone is mechanical.
    { key: 'AI_ENRICH_ENABLED', type: 'boolean', group: 'ai', public: false, live: true, label: 'AI enrichment', hint: 'M4.1 three-call collection for upcoming fixtures (bills per fixture); feeds NO ranking.' },
    { key: 'AI_ENRICH_CAP', type: 'int', group: 'ai', public: false, live: true, min: 0, max: 2000, unit: 'fixtures', label: 'Enrichment cap', hint: 'Fixtures enriched per run (each costs up to 3 AI calls).' },
    { key: 'AI_ENRICH_CONCURRENCY', type: 'int', group: 'ai', public: false, live: true, min: 1, max: 16, label: 'Enrichment concurrency', hint: 'In-flight fixtures during an enrichment run (network calls only).' },
    { key: 'OPENROUTER_MODEL', type: 'string', group: 'ai', public: false, live: true, label: 'Blind reasoner model', hint: 'OpenRouter model id for the blind task; must NOT be a Google model (reasoner independence).' },
    { key: 'AI_BLIND_MODEL', type: 'string', group: 'ai', public: false, live: true, label: 'Blind model override', hint: 'Overrides the blind task\'s model; blank = provider default (OPENROUTER_MODEL).' },
    { key: 'AI_ANCHORED_MODEL', type: 'string', group: 'ai', public: false, live: true, label: 'Anchored model override', hint: 'Overrides the anchored task\'s Gemini model; blank = provider default.' },
    { key: 'HOTPICK_AI_MODEL', type: 'string', group: 'ai', public: false, live: true, regime: true, label: 'Adjudicator model', hint: 'Gemini model for hot-pick/tip verdicts; switching re-keys the reuse tag and re-adjudicates upcoming rows.' },
    { key: 'HOTPICK_AI_WEB', type: 'boolean', group: 'ai', public: false, live: true, regime: true, label: 'Adjudicator web grounding', hint: 'Attach Google Search grounding to verdict calls (bills extra; flips the model tag -> re-adjudication).' },
    { key: 'TIP_AI_MIN_CONFIDENCE', type: 'number', group: 'ai', public: false, live: true, regime: true, min: 0, max: 1, label: 'Tip review floor', hint: 'Only tips at/above this confidence get an AI review (best-first under the daily budget).' },
    { key: 'TIP_AI_DAILY_CAP', type: 'int', group: 'ai', public: false, live: true, regime: true, min: 0, unit: 'verdicts', label: 'Tip review daily budget', hint: 'Fresh (billed) tip verdicts per EAT day; reused verdicts are free.' },
    { key: 'HOTPICK_AI_CONCURRENCY', type: 'int', group: 'ai', public: false, live: true, min: 1, max: 16, label: 'AI review concurrency', hint: 'Concurrent verdict calls in the review worker (network only - DB writes stay sequential).' },
    { key: 'TIP_AI_REUSE_PRICE_TOL', type: 'number', group: 'ai', public: false, live: true, regime: true, min: 0, max: 0.5, label: 'Verdict reuse tolerance', hint: 'Reuse a stored tip verdict within this relative price drift; 0 = exact price only.' },
    { key: 'AI_RUN_MAX_MINUTES', type: 'number', group: 'ai', public: false, live: true, min: 0, unit: 'min', label: 'AI run budget', hint: 'Wall-clock budget per drain/enrich run; 0 = off (call counts are capped separately).' },
    { key: 'AI_BREAKER_AFTER', type: 'int', group: 'ai', public: false, live: true, min: 0, max: 100, label: 'AI circuit breaker', hint: 'Consecutive transport/parse failures before the rest of the run is refused instantly.' },
    // ---- DARK AI switches (T10). Spec decision 3 (2026-07-19) supersedes the
    // .env-only policy: admin-editable WITH regime warnings - the dated
    // admin_audit trail replaces the manual memory-bank dated-note discipline.
    { key: 'AI_INJECTION_PREAMBLE', type: 'boolean', group: 'ai-dark', public: false, live: true, regime: true, label: 'DARK: injection preamble', hint: 'Prepends the injection guard to grounded prompts; bumps prompt tags (#p/#e) - one bounded re-adjudication wave while on.' },
    { key: 'AI_CONSENSUS_TASKS', type: 'string', group: 'ai-dark', public: false, live: true, regime: true, pattern: '^$|^[a-z_]+(\\s*,\\s*[a-z_]+)*$', patternHint: 'CSV of task keys, e.g. adjudicate', label: 'DARK: consensus tasks', hint: 'Tasks routed to a cross-vendor panel (only adjudicate is wired); blank = off.' },
    { key: 'AI_CONSENSUS_MODELS', type: 'string', group: 'ai-dark', public: false, live: true, regime: true, pattern: '^$|^[\\w.-]+:[^,\\s]+(\\s*,\\s*[\\w.-]+:[^,\\s]+)*$', patternHint: 'CSV of provider:model entries', label: 'DARK: consensus panel', hint: 'provider:model CSV for the panel; must span vendors (one vendor agreeing with itself is not consensus).' },
    { key: 'AI_CONSENSUS_MIN_AGREE', type: 'int', group: 'ai-dark', public: false, live: true, regime: true, min: 2, max: 9, label: 'DARK: consensus floor', hint: 'Per-field agreement minimum; disagreement below it throws (the panel never guesses).' },
    // ---- Auth policy (creds/pepper stay .env-only; AUTH_ENABLED stays a boot
    // switch - an admin flipping it from inside a session would saw off the
    // branch the settings UI sits on).
    { key: 'SESSION_TTL_DAYS', type: 'number', group: 'auth-policy', public: false, live: true, min: 0.01, unit: 'days', label: 'Session lifetime', hint: 'How long a sign-in session lasts before it expires.' },
    { key: 'PIN_MAX_ATTEMPTS', type: 'int', group: 'auth-policy', public: false, live: true, min: 1, unit: 'tries', label: 'PIN attempts', hint: 'Wrong PIN entries before the account locks out.' },
    { key: 'PIN_LOCKOUT_MINUTES', type: 'int', group: 'auth-policy', public: false, live: true, min: 1, unit: 'min', label: 'PIN lockout', hint: 'Lockout duration after too many wrong PINs.' },
    // ---- OTP policy.
    { key: 'OTP_TTL_MINUTES', type: 'int', group: 'otp', public: false, live: true, min: 1, unit: 'min', label: 'OTP expiry', hint: 'Verification codes expire after this long.' },
    { key: 'OTP_LENGTH', type: 'int', group: 'otp', public: false, live: true, min: 4, max: 10, unit: 'digits', label: 'OTP length', hint: 'Digits in a verification code.' },
    { key: 'OTP_MAX_ATTEMPTS', type: 'int', group: 'otp', public: false, live: true, min: 1, unit: 'tries', label: 'OTP verify attempts', hint: 'Wrong code entries before the OTP is exhausted and a new one is required.' },
    { key: 'OTP_RESEND_BASE_SECONDS', type: 'int', group: 'otp', public: false, live: true, min: 1, unit: 's', label: 'OTP resend backoff', hint: 'Resend cooldown = base x resend count.' },
    { key: 'OTP_MAX_RESENDS', type: 'int', group: 'otp', public: false, live: true, min: 1, unit: 'sends', label: 'OTP resend cap', hint: 'Hard cap on resends per verification cycle.' },
    // ---- SMS (creds stay .env-only).
    { key: 'SMS_ENABLED', type: 'boolean', group: 'sms', public: false, live: true, label: 'SMS sending', hint: 'Off = zero network; OTP codes log to the server console instead (dev mode).' },
    { key: 'SMS_DEFAULT_REGION', type: 'string', group: 'sms', public: false, live: true, pattern: '^[A-Z]{2}$', patternHint: 'two-letter ISO country, e.g. KE', label: 'Default phone region', hint: 'ISO country used to parse local phone-number formats into E.164.' },
    { key: 'BONGA_SERVICE_ID', type: 'int', group: 'sms', public: false, live: true, label: 'Bonga service ID', hint: 'Vendor service/sender id attached to SMS sends.' },
    // ---- Visitor geo backfill. The sweep INTERVAL is read once at scheduler
    // start -> restart; the per-sweep batch size/URL are late-read -> live.
    { key: 'GEO_RESOLVE_ENABLED', type: 'boolean', group: 'geo', public: false, live: false, label: 'Geo backfill', hint: 'Resolve visitor IPs to country/region in a background sweep. Restart to apply.' },
    { key: 'GEO_INTERVAL_MINUTES', type: 'int', group: 'geo', public: false, live: false, min: 1, unit: 'min', label: 'Geo sweep cadence', hint: 'Minutes between backfill sweeps. Restart to apply (read at scheduler start).' },
    { key: 'GEO_BATCH_LIMIT', type: 'int', group: 'geo', public: false, live: true, min: 1, max: 100, unit: 'IPs', label: 'Geo batch size', hint: 'IPs resolved per sweep (ip-api free batch cap is 100).' },
    { key: 'GEO_API_BATCH_URL', type: 'string', group: 'geo', public: false, live: true, pattern: '^https?://.+$', patternHint: 'http(s):// URL', label: 'Geo resolver URL', hint: 'Batch resolver endpoint; the default free ip-api.com tier is HTTP-only (visitor IPs go to a third party).' },
    // ---- Bot UA filter.
    { key: 'BOT_UA_FILTER_ENABLED', type: 'boolean', group: 'bot', public: false, live: true, label: 'Bot UA filter', hint: 'Block known AI-scraper/aggressive-crawler user agents site-wide (search engines exempt).' },
    { key: 'BOT_UA_EXTRA', type: 'string', group: 'bot', public: false, live: true, label: 'Blocked UA substrings', hint: 'Comma-separated user-agent substrings ADDED to the blocklist.' },
    { key: 'BOT_UA_ALLOW', type: 'string', group: 'bot', public: false, live: true, label: 'Exempt UA substrings', hint: 'Comma-separated user-agent substrings EXEMPTED from the blocklist.' },
    // ---- Logging.
    { key: 'DEBUG', type: 'boolean', group: 'logging', public: false, live: true, label: 'Verbose debug logs', hint: 'Per-step pipeline timing logs (utils.debugLog) on the server console.' },
    { key: 'AUTO_LOG', type: 'boolean', group: 'logging', public: false, live: true, label: 'Auto-refresh job log', hint: 'Write per-job lines to logs/auto-refresh.log.' },
    { key: 'AUTO_LOG_MAX_KB', type: 'int', group: 'logging', public: false, live: true, min: 16, unit: 'KB', label: 'Auto-refresh log cap', hint: 'Self-truncating tail size of the job log (the host has no rotation).' },
    // ---- Tracking (M2 beacon warehouse).
    { key: 'TRACK_EVENTS_RETENTION_DAYS', type: 'int', group: 'tracking', public: false, live: true, min: 0, unit: 'days', label: 'Event retention', hint: 'Prune visit_events older than this in the light pass; 0 = keep forever (default - behavior data accumulates).' },
];

const BY_KEY = new Map(SETTINGS_CATALOG.map(e => [e.key, e]));
export function catalogEntry(key, catalog = SETTINGS_CATALOG) {
    return catalog === SETTINGS_CATALOG ? (BY_KEY.get(key) ?? null) : (catalog.find(e => e.key === key) ?? null);
}

// Coerce a stored string value to the catalog type. Booleans use the SAME
// explicit truthy set as config.js (never z.coerce.boolean - "0" would be true).
export function coerceValue(type, raw) {
    if (raw == null) return raw;
    switch (type) {
        // 'int' coerces with plain Number so a non-integer stays non-integer for
        // validateSetting to REJECT (truncating would silently accept "2.5").
        case 'int':
        case 'number': return Number(raw);
        case 'boolean': return ['1', 'true', 'yes'].includes(String(raw).toLowerCase());
        default: return String(raw);
    }
}

// Validate a proposed override -> { ok, value } | { ok:false, error }.
export function validateSetting(key, raw, catalog = SETTINGS_CATALOG) {
    const e = catalogEntry(key, catalog);
    if (!e) return { ok: false, error: `Unknown or non-editable setting: ${key}` };
    const value = coerceValue(e.type, raw);
    if (e.type === 'int' || e.type === 'number') {
        if (!Number.isFinite(value)) return { ok: false, error: `${key} must be a number` };
        if (e.type === 'int' && !Number.isInteger(value)) return { ok: false, error: `${key} must be a whole number` };
        if (e.min != null && value < e.min) return { ok: false, error: `${key} must be >= ${e.min}` };
        if (e.max != null && value > e.max) return { ok: false, error: `${key} must be <= ${e.max}` };
    }
    if (e.pattern && e.type === 'string' && !new RegExp(e.pattern).test(value)) {
        return { ok: false, error: `${key} must be ${e.patternHint || `matching ${e.pattern}`}` };
    }
    if (e.enum && !e.enum.includes(value)) return { ok: false, error: `${key} must be one of: ${e.enum.join(', ')}` };
    return { ok: true, value };
}

// Batch-validate [key, raw] entries - ALL must pass before ANY is applied
// (all-or-nothing, M7). Collects every error so the admin fixes the batch in
// one round-trip instead of discovering failures one 400 at a time.
export function validateSettings(entries, catalog = SETTINGS_CATALOG) {
    if (!Array.isArray(entries) || !entries.length) {
        return { ok: false, errors: ['No settings provided'] };
    }
    const values = [];
    const errors = [];
    for (const [key, raw] of entries) {
        const v = validateSetting(key, raw, catalog);
        if (v.ok) values.push({ key, value: v.value });
        else errors.push(v.error);
    }
    return errors.length ? { ok: false, errors } : { ok: true, values };
}

// MySQL "table doesn't exist" (ER_NO_SUCH_TABLE / 1146): the one load error
// that legitimately means "no overrides yet" (pre-migration boot). Anything
// else is a transient failure the loader must NOT paper over with an empty
// override set (M1).
export function isMissingTableError(e) {
    return e?.code === 'ER_NO_SUCH_TABLE' || e?.errno === 1146;
}

// Merge coerced overrides over the config defaults for every catalog key.
export function mergeOverrides(defaults, overrides, catalog = SETTINGS_CATALOG) {
    const out = {};
    for (const e of catalog) {
        const has = overrides && Object.prototype.hasOwnProperty.call(overrides, e.key) && overrides[e.key] != null;
        out[e.key] = has ? coerceValue(e.type, overrides[e.key]) : defaults[e.key];
    }
    return out;
}

// Client-safe subset of an effective settings object (public keys only).
export function publicSubset(effective, catalog = SETTINGS_CATALOG) {
    const out = {};
    for (const e of catalog) if (e.public && e.key in effective) out[e.key] = effective[e.key];
    return out;
}

// ---- admin_audit rows (M6) --------------------------------------------------
export const AUDIT_SETTINGS_SET = 'settings.set';
export const AUDIT_SETTINGS_RESET = 'settings.reset';

// Build the audit rows for a batch of override writes - PURE so the
// changed-only contract is offline-assertable. `previous` maps key -> the
// currently STORED override string (absent/null = no override). A write whose
// stored value would not change leaves NO trail (re-saving the same value is
// not a policy event); a reset of a key that was never overridden likewise.
// Values are audited as the STRINGS the settings table stores - old_value
// null means "was at config default", new_value null means "reset to default".
export function buildAuditRows(entries, previous = {}, { actorId = null, action = AUDIT_SETTINGS_SET } = {}) {
    const rows = [];
    for (const [key, value] of entries) {
        const oldValue = previous?.[key] != null ? String(previous[key]) : null;
        const newValue = value != null ? String(value) : null;
        if (oldValue === newValue) continue;
        rows.push({ actor_id: actorId, action, target: key, old_value: oldValue, new_value: newValue });
    }
    return rows;
}
