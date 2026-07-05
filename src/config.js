import 'dotenv/config';
import { z } from 'zod';
import { DEFAULT_THRESHOLDS } from './db/goals-rules.js'; // zero-import module - no cycle
import { DEFAULT_TIP } from './db/tip-rules.js'; // zero-import module - no cycle

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
});

export const config = EnvSchema.parse(process.env);
