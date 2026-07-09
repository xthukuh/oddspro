import 'dotenv/config';
import { z } from 'zod';
import { DEFAULT_THRESHOLDS } from './db/goals-rules.js'; // zero-import module - no cycle
import { DEFAULT_TIP } from './db/tip-rules.js'; // zero-import module - no cycle
import { DEFAULT_SAFE, STRATEGIES } from './db/magic-rules.js'; // imports only perf-rules - no cycle

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
    BETPAWA_BASE_URL: z.string().url().optional(),
    BETIKA_BASE_URL: z.string().url().optional(),
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
    // AI adjudication is optional: no key = rules-only verdicts (fail-open).
    // Google Gemini (https://aistudio.google.com/apikey) replaced OpenRouter
    // 2026-07-04 - stronger reasoner + native Google Search grounding.
    GEMINI_API_KEY: z.string().min(1).optional(),
    GEMINI_URL: z.string().url().default('https://generativelanguage.googleapis.com/v1beta'),
    HOTPICK_AI_MODEL: z.string().default('gemini-2.5-flash'),
    // Web-grounded AI: attach Gemini's google_search tool for BOTH
    // adjudicators. Opt-in - grounded requests bill extra per call.
    // z.coerce.boolean would treat "0"/"false" as true; parse explicitly.
    HOTPICK_AI_WEB: z.string().default('0').transform(v => ['1', 'true', 'yes'].includes(v.toLowerCase())),
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
    API_TOKEN: z.string().min(1).optional(),
    // knex pool sizing (knexfile.js). Defaults preserve the existing hardcoded
    // 0/10. The cron pipeline and the always-on server are separate processes
    // with separate pools - shared hosting connection caps may need this lower.
    DB_POOL_MIN: z.coerce.number().int().min(0).default(0),
    DB_POOL_MAX: z.coerce.number().int().min(1).default(10),
    // Verbose per-step timing logs (src/pipeline.js) via src/utils.js#debugLog.
    // z.coerce.boolean would treat "0"/"false" as true; parse explicitly.
    DEBUG: z.string().default('0').transform(v => ['1', 'true', 'yes'].includes(v.toLowerCase())),
    // POST /api/refresh per-date cooldown (server.js): blocks re-triggering
    // the SAME date again until this many minutes after its last run finished
    // (success or failure). 0 = disabled (today's behavior).
    REFRESH_COOLDOWN_MINUTES: z.coerce.number().min(0).default(60),
    // In-process auto-refresh scheduler (src/auto-refresh.js, runs inside
    // `npm run serve`): light pass (scores/outcomes + today's odds + link)
    // every AUTO_LIGHT_MINUTES, full pipeline (runStartPipeline) once daily
    // at AUTO_FULL_AT (EAT wall-clock, matching the warehouse convention).
    AUTO_REFRESH_ENABLED: z.string().default('1').transform(v => ['1', 'true', 'yes'].includes(v.toLowerCase())),
    AUTO_LIGHT_MINUTES: z.coerce.number().int().min(0).default(10), // 0 = light mode off
    AUTO_FULL_AT: z.string().default('06:00'),                      // ''/off = full mode off
    AUTO_FULL_DAYS: z.coerce.number().int().min(0).default(5),      // days ahead for the daily sweep
    // Per-job log lines in logs/auto-refresh.log (self-truncating - the host
    // has no log rotation and tight disk quotas).
    AUTO_LOG: z.string().default('1').transform(v => ['1', 'true', 'yes'].includes(v.toLowerCase())),
    AUTO_LOG_MAX_KB: z.coerce.number().int().min(16).default(256),
    // Manual POST /api/refresh answered `200 {fresh:true}` (no re-run) when the
    // date was successfully refreshed - any mode - within this window. 0 = off.
    REFRESH_CACHE_MINUTES: z.coerce.number().min(0).default(5),
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
});

// PORT is the convention Passenger/most Node PaaS hosts use to hand the app
// its assigned port; API_PORT wins if the user also sets it explicitly.
const rawEnv = { ...process.env };
if (!rawEnv.API_PORT && rawEnv.PORT) rawEnv.API_PORT = rawEnv.PORT;

export const config = EnvSchema.parse(rawEnv);
