import 'dotenv/config';
import { z } from 'zod';
import { DEFAULT_THRESHOLDS } from './db/goals-rules.js'; // zero-import module - no cycle
import { DEFAULT_TIP } from './db/tip-rules.js'; // zero-import module - no cycle
import { DEFAULT_SAFE, STRATEGIES } from './db/magic-rules.js'; // imports only perf-rules - no cycle
import { shouldMigrateOnBoot } from './db/migrate-rules.js'; // zero-import module - no cycle

// A committed-but-blank .env line (`KEY=`, the .env.example shape) reaches zod
// as '' - treat that as unset for optional strings, else `.min(1).optional()`
// throws a ZodError at import and kills every CLI over a blank line unrelated
// to what's being run (M4).
const optionalStr = inner => z.preprocess(v => (v === '' ? undefined : v), inner);

// Boolean env flags parsed explicitly (z.coerce.boolean would treat "0"/"false"
// as true). One helper for every on/off knob (C1); default is '0' or '1'.
const boolStr = dflt => z.string().default(dflt).transform(v => ['1', 'true', 'yes'].includes(v.toLowerCase()));

// Environment schema - external data validated with zod (names match .env)
const EnvSchema = z.object({
    DB_HOST: z.string().default('127.0.0.1'),
    DB_PORT: z.coerce.number().int().positive().default(3306),
    DB_DATABASE: z.string().default('oddspro'),
    DB_USERNAME: z.string().default('root'),
    DB_PASSWORD: z.string().default(''),
    DB_CHARSET: z.string().default('utf8mb4'),
    DB_COLLATION: z.string().default('utf8mb4_unicode_ci'),
    X_APISPORTS_URL: z.string().url().default('https://v3.football.api-sports.io'),
    X_APISPORTS_KEY: z.string().min(1, 'X_APISPORTS_KEY is required (see .env.example)'),
    BETPAWA_BASE_URL: optionalStr(z.string().url().optional()),
    BETIKA_BASE_URL: optionalStr(z.string().url().optional()),
    APISPORTS_MIN_REMAINING: z.coerce.number().int().min(0).default(5),
    LINK_MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.85),
    // Rolling windows for the pre-match goals aggregates (fixture_prematch)
    PREMATCH_TEAM_WINDOW: z.coerce.number().int().min(1).default(5),
    PREMATCH_H2H_WINDOW: z.coerce.number().int().min(1).default(5),
    // Over 2.5 hot picks: gate thresholds (defaults tuned by the backtest,
    // scripts/backtest-hotpicks.js) + optional Google Gemini AI adjudicator
    HOTPICK_TEAM_WINDOW: z.coerce.number().int().min(1).default(DEFAULT_THRESHOLDS.teamWindow),
    HOTPICK_MIN_GAMES: z.coerce.number().int().min(1).default(DEFAULT_THRESHOLDS.minGames),
    HOTPICK_MIN_OVER_RATE: z.coerce.number().min(0).max(1).default(DEFAULT_THRESHOLDS.minOverRate),
    HOTPICK_MIN_AVG_TOTAL: z.coerce.number().min(0).default(DEFAULT_THRESHOLDS.minAvgTotal),
    HOTPICK_MIN_IMPLIED_OVER: z.coerce.number().min(0).max(1).default(DEFAULT_THRESHOLDS.minImpliedOver),
    HOTPICK_H2H_MIN_OVER_RATE: z.coerce.number().min(0).max(1).default(DEFAULT_THRESHOLDS.h2hMinOverRate),
    // "Tip" column: safest bettable outcome floors (see src/db/tip-rules.js)
    TIP_MIN_PRICE: z.coerce.number().min(1).default(DEFAULT_TIP.minPrice),
    TIP_MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(DEFAULT_TIP.minConfidence),
    TIP_MIN_UNDER_LINE: z.coerce.number().min(0).default(DEFAULT_TIP.minUnderLine),
    // Book-integrity guards (M3): family-book overround band + cross-provider
    // devigged-probability divergence veto (see src/db/tip-rules.js)
    TIP_MIN_OVERROUND: z.coerce.number().default(DEFAULT_TIP.minOverround),
    TIP_MAX_OVERROUND: z.coerce.number().default(DEFAULT_TIP.maxOverround),
    TIP_MAX_BOOK_DIVERGENCE: z.coerce.number().default(DEFAULT_TIP.maxBookDivergence),
    // AI adjudication is optional: no key = rules-only verdicts (fail-open).
    // Google Gemini (https://aistudio.google.com/apikey) replaced OpenRouter
    // 2026-07-04 - stronger reasoner + native Google Search grounding.
    GEMINI_API_KEY: optionalStr(z.string().min(1).optional()),
    GEMINI_URL: z.string().url().default('https://generativelanguage.googleapis.com/v1beta'),
    HOTPICK_AI_MODEL: z.string().default('gemini-2.5-flash'),
    // Web-grounded AI: attach Gemini's google_search tool for BOTH
    // adjudicators. Opt-in - grounded requests bill extra per call.
    HOTPICK_AI_WEB: boolStr('0'),
    // Tip AI review: only tips at/above this confidence, best-first, at most
    // this many fresh verdicts per run (cached verdicts don't count).
    TIP_AI_MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.75),
    TIP_AI_DAILY_CAP: z.coerce.number().int().min(0).default(20),
    API_PORT: z.coerce.number().int().positive().default(3001),
    // Loopback by default - set 0.0.0.0 to expose the dashboard on the LAN
    // (the refresh endpoint triggers scrapes; don't expose it unknowingly)
    API_HOST: z.string().default('127.0.0.1'),
    // Optional: require `Authorization: Bearer <token>` on /api/* (server.js).
    // Unset = today's behavior (same-origin X-Requested-With check only).
    API_TOKEN: optionalStr(z.string().min(1).optional()),
    // Optional: admin secret guarding the traffic dashboard (GET /admin +
    // GET /api/visits/summary). Kept SEPARATE from API_TOKEN so a public SPA
    // (API_TOKEN unset, /api open) can still lock the admin views. Falls back to
    // API_TOKEN when unset; admin is disabled (404) if neither is set.
    ADMIN_TOKEN: optionalStr(z.string().min(1).optional()),
    // knex pool sizing (knexfile.js). Defaults preserve the existing hardcoded
    // 0/10. The cron pipeline and the always-on server are separate processes
    // with separate pools - shared hosting connection caps may need this lower.
    DB_POOL_MIN: z.coerce.number().int().min(0).default(0),
    DB_POOL_MAX: z.coerce.number().int().min(1).default(10),
    // Self-apply pending knex migrations when the server (src/server.js) boots.
    // OFF by default (local/dev restarts never migrate); a shell-less shared
    // host (cPanel) sets this so restarting the Node app runs migrate:latest.
    // Coercion shared with the offline-tested guard (src/db/migrate-rules.js).
    MIGRATE_ON_BOOT: z.string().default('0').transform(shouldMigrateOnBoot),
    // --- SPA bot-protection (opt-in; src/server.js + web/src/HumanGate.jsx) ---
    // Stateless proof-of-work "verify you're human" gate. Enable on BOTH sides
    // together: HUMAN_POW_ENABLED here AND VITE_HUMAN_POW at web build time.
    HUMAN_POW_ENABLED: boolStr('0'),
    HUMAN_POW_BITS: z.coerce.number().int().min(1).max(28).default(18),   // difficulty (~2^bits hashes, <1s in-browser)
    HUMAN_TOKEN_SECRET: optionalStr(z.string().min(1).optional()),        // HMAC key; set for a stable check-once across restarts
    HUMAN_TOKEN_TTL_DAYS: z.coerce.number().min(0.01).default(7),         // check-once lifetime (~1 week per the user's ask)
    HUMAN_CHALLENGE_TTL_MINUTES: z.coerce.number().min(1).default(10),
    // Known-bot user-agent blocklist (+ AI-crawler robots.txt), src/bot-rules.js.
    // Blocks AI scrapers / aggressive crawlers / raw HTTP clients; general search
    // engines are intentionally left alone (landing-page SEO).
    BOT_UA_FILTER_ENABLED: boolStr('0'),
    BOT_UA_EXTRA: z.string().default(''),   // comma-separated extra UA substrings to block
    BOT_UA_ALLOW: z.string().default(''),   // comma-separated UA substrings to exempt
    // Verbose per-step timing logs (src/pipeline.js) via src/utils.js#debugLog.
    DEBUG: boolStr('0'),
    // POST /api/refresh per-date cooldown (server.js): blocks re-triggering
    // the SAME date again until this many minutes after its last run finished
    // (success or failure). 0 = disabled (today's behavior).
    REFRESH_COOLDOWN_MINUTES: z.coerce.number().min(0).default(60),
    // In-process auto-refresh scheduler (src/auto-refresh.js, runs inside
    // `npm run serve`): light pass (scores/outcomes + today's odds + link)
    // every AUTO_LIGHT_MINUTES, full pipeline (runStartPipeline) once daily
    // at AUTO_FULL_AT (EAT wall-clock, matching the warehouse convention).
    AUTO_REFRESH_ENABLED: boolStr('1'),
    AUTO_LIGHT_MINUTES: z.coerce.number().int().min(0).default(10), // 0 = light mode off
    AUTO_FULL_AT: z.string().default('06:00'),                      // ''/off = full mode off
    AUTO_FULL_DAYS: z.coerce.number().int().min(0).default(5),      // days ahead for the daily sweep
    // Per-job log lines in logs/auto-refresh.log (self-truncating - the host
    // has no log rotation and tight disk quotas).
    AUTO_LOG: boolStr('1'),
    AUTO_LOG_MAX_KB: z.coerce.number().int().min(16).default(256),
    // Manual POST /api/refresh answered `200 {fresh:true}` (no re-run) when the
    // date was successfully refreshed - any mode - within this window. 0 = off.
    REFRESH_CACHE_MINUTES: z.coerce.number().min(0).default(5),
    // Visitor geo backfill (src/geo.js): a background sweep resolves each newly
    // seen visitor IP to country/region and caches the result per-IP (ip_geo),
    // marking unresolvable/private IPs so they're never re-queried. Default
    // provider is ip-api.com's free batch endpoint (no key; HTTP-only free tier
    // = visitor IPs go to a third party - point GEO_API_BATCH_URL at a keyed
    // HTTPS or self-hosted resolver to change that). Runs only when there are
    // public IPs to resolve, so a localhost-only dev box makes no external calls.
    GEO_RESOLVE_ENABLED: boolStr('1'),
    GEO_INTERVAL_MINUTES: z.coerce.number().int().min(1).default(10),  // sweep cadence
    GEO_BATCH_LIMIT: z.coerce.number().int().min(1).max(100).default(100), // IPs resolved per sweep (ip-api batch cap = 100)
    GEO_API_BATCH_URL: z.string().default('http://ip-api.com/batch'),
    // Safe-only slip-leg selection (the web's 🛡 Safe-only toggle). Defaults =
    // DEFAULT_SAFE in src/db/magic-rules.js; the browser can't read .env, so
    // these are shipped to the client via /api/magic-sort (server and client
    // agree - no divergence). SAFE_MAX_PER_DAY is the "how many per day" knob;
    // the gate thresholds are best tuned from scripts/analyze-safe-tips.js.
    SAFE_STRATEGY: z.string().default(DEFAULT_SAFE.strategy)
        .refine(v => STRATEGIES.some(s => s.id === v), 'SAFE_STRATEGY must be a known magic strategy id'),
    SAFE_MIN_PARTS: z.coerce.number().int().min(1).max(3).default(DEFAULT_SAFE.minParts),
    SAFE_MIN_AGREEMENT: z.coerce.number().min(0).max(1).default(DEFAULT_SAFE.minAgreement),
    SAFE_MAX_PRICE: z.coerce.number().min(1).default(DEFAULT_SAFE.maxPrice),
    SAFE_MAX_PER_DAY: z.coerce.number().int().min(1).default(DEFAULT_SAFE.maxPerDay),
    // Stats-sufficiency ("exclude risky bets") gate - min rolling sample per
    // side and min head-to-head meetings. Shipped to the client so the magic/
    // Safe risk filter uses identical thresholds. 0 = that gate off.
    SAFE_MIN_SAMPLES: z.coerce.number().int().min(0).default(DEFAULT_SAFE.minSamples),
    SAFE_MIN_H2H: z.coerce.number().int().min(0).default(DEFAULT_SAFE.minH2H),
    // --- User accounts / auth (v1.1.0; src/auth-rules.js + src/auth.js) -------
    // Server-wide pepper mixed into every scrypt PIN hash. Optional but STRONGLY
    // recommended in production. WARNING: changing it invalidates every existing
    // PIN hash (a deliberate global reset lever) - Phase 3's auth service warns
    // loudly at boot when it's unset. Read directly from process.env by the users
    // migration too, so set it BEFORE `npm run migrate` seeds the admin.
    PIN_PEPPER: optionalStr(z.string().min(1).optional()), // '' = unset, so the boot warning stays honest
    // First-login bootstrap PIN for the seeded default admin (users migration).
    // Hashed at migrate time; the admin is flagged must_change_pin, so it can
    // only be used once to log in and immediately set a real PIN.
    // Constrained to the loginSchema PIN shape (^\d{4}$): a 6-digit seed would
    // hash fine but could never pass login validation, bricking the seeded
    // admin behind a forward-only migration (M5). knexfile imports this config,
    // so `npm run migrate` fail-fasts here BEFORE the seed hashes a bad PIN.
    ADMIN_SEED_PIN: z.string().regex(/^\d{4}$/, 'ADMIN_SEED_PIN must be exactly 4 digits (login requires a 4-digit PIN)').default('0000'),
    // Master switch for the whole user-accounts feature (routes/middleware).
    AUTH_ENABLED: boolStr('1'),
    // Opaque DB session lifetime; PIN lockout policy (src/auth-rules.js).
    SESSION_TTL_DAYS: z.coerce.number().min(0.01).default(30),
    PIN_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(5),   // wrong PINs before lockout
    PIN_LOCKOUT_MINUTES: z.coerce.number().int().min(1).default(15),
    // --- SMS provider + OTP (v1.1.0; src/sms/*, src/db/sms-rules.js) ----------
    // SMS is used only for phone-verification OTPs. OFF by default: with
    // SMS_ENABLED off no network call is made and the OTP is logged to the
    // server console, so signup/verify works in dev without a provider account.
    SMS_ENABLED: boolStr('0'),
    SMS_DEFAULT_REGION: z.string().default('KE'),   // ISO region for phone parsing (web input)
    // Bonga SMS (https://app.bongasms.co.ke). The send host is plain HTTP, so
    // its URL is z.string() (NOT .url() https). Creds are optional at parse time
    // and checked at send time (fail-closed with a clear message when SMS_ENABLED
    // is on but creds are missing).
    BONGA_API_URL_SEND: z.string().default('http://167.172.14.50:4002/v1/send-sms'),
    BONGA_API_URL_BALANCE: z.string().default('https://app.bongasms.co.ke/api/check-credits'),
    BONGA_API_URL_DELIVERY: z.string().default('https://app.bongasms.co.ke/api/fetch-delivery'),
    BONGA_API_CLIENT_ID: optionalStr(z.string().min(1).optional()),
    BONGA_API_KEY: optionalStr(z.string().min(1).optional()),
    BONGA_API_SECRET: optionalStr(z.string().min(1).optional()),
    BONGA_SERVICE_ID: z.coerce.number().int().default(1),
    // OTP policy (src/db/sms-rules.js): 6-digit codes, 10-min TTL, 5 verify
    // attempts, resend backoff 60·n up to 5 resends.
    OTP_TTL_MINUTES: z.coerce.number().int().min(1).default(10),
    OTP_LENGTH: z.coerce.number().int().min(4).max(10).default(6),
    OTP_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(5),
    OTP_RESEND_BASE_SECONDS: z.coerce.number().int().min(1).default(60),
    OTP_MAX_RESENDS: z.coerce.number().int().min(1).default(5),
});

// PORT is the convention Passenger/most Node PaaS hosts use to hand the app
// its assigned port; API_PORT wins if the user also sets it explicitly.
const rawEnv = { ...process.env };
if (!rawEnv.API_PORT && rawEnv.PORT) rawEnv.API_PORT = rawEnv.PORT;

export const config = EnvSchema.parse(rawEnv);
