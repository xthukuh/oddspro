import express from 'express';
import compression from 'compression';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { queryRecords, columnCatalog } from './db/records.js';
import { hotpicksSummary, performanceSummary } from './hotpicks.js';
import { magicSortCached } from './magic.js';
import { runDateRefresh } from './pipeline.js';
import { refreshStatus, startJob, requestCancel, lastFreshAt, startAutoRefresh, stopAutoRefresh } from './auto-refresh.js';
import { db, closeDb } from './db/connection.js';
import { describeMigrationResult } from './db/migrate-rules.js';
import { bearerMatches } from './crypto-utils.js';
import { isBlockedUserAgent, AI_ROBOTS_TXT } from './bot-rules.js';
import { shouldLogVisit } from './db/visit-rules.js';
import { visitRowFromReq, logVisit, dailyUniqueVisitors, visitsSummary } from './visits.js';
import { startGeoScheduler, stopGeoScheduler } from './geo.js';
import { ADMIN_HTML } from './admin-dashboard.js';
import {
    AuthError, publicUser, createUser, authenticate, mintSession, resolveSession,
    revokeSession, revokeAllForUser, issueOtp, resendOtp, verifyOtp, changePhone, updateProfile,
} from './auth.js';
import {
    signupSchema, loginSchema, verifyOtpSchema, changePhoneSchema, profileSchema, mustChangePinBlocks,
} from './auth-rules.js';
import { slidingWindowAllow } from './authlimit-rules.js';
import { validatePrefsPut } from './db/prefs-rules.js';
import { accessFromUser, guestDateAllowed } from './db/access-rules.js';
import { getUserPrefs, saveUserPrefs } from './prefs.js';
import { loadOverrides, effective, publicSettings, adminSettings, setOverrides, resetOverride } from './settings.js';
import { settingsPutSchema } from './db/settings-rules.js';
import { labData, LAB_DEFAULTS } from './lab.js';
import { LAB_FEATURES, LAB_OUTCOMES } from './db/lab-rules.js';
import { makeJsonCache, sendJson } from './http-cache.js';
import { queryCacheKey } from './db/cache-rules.js';
import { _dtime } from './utils.js';

// Visualization API server (:3001). Serves the paginated/multi-sort/filtered
// records endpoint over the warehouse plus the column catalog for the web
// settings modal, and the built web/dist frontend when present.
// Start with `npm run serve`; the vite dev server proxies /api/* here.

const app = express();
app.disable('x-powered-by');
// Behind cPanel/Passenger (or any reverse proxy) the socket peer is the proxy;
// trust it so req.ip / X-Forwarded-For reflect the real visitor (visit logging).
app.set('trust proxy', true);

// Bot user-agent blocklist (opt-in, BOT_UA_FILTER_ENABLED). Blocks known AI
// scrapers / aggressive crawlers / raw HTTP clients site-wide before any route;
// general search engines are deliberately NOT blocked (landing-page SEO). Tune
// via BOT_UA_EXTRA (add) / BOT_UA_ALLOW (exempt). See src/bot-rules.js.
// Always registered; the flag is late-read per request so the admin override
// applies live (H3) - a disabled filter costs one Map lookup per request.
const _uaList = s => String(s || '').split(',').map(x => x.trim()).filter(Boolean);
{
    const extra = _uaList(config.BOT_UA_EXTRA);
    const allow = _uaList(config.BOT_UA_ALLOW);
    app.use((req, res, next) => {
        if (!effective('BOT_UA_FILTER_ENABLED')) return next();
        if (isBlockedUserAgent(req.get('user-agent') || '', { extra, allow })) {
            return res.status(403).type('text/plain').send('Forbidden');
        }
        next();
    });
}
// AI-crawler robots.txt (always served): politely disallows LLM crawlers + /api;
// the impolite ones that ignore it are caught by the UA blocklist above.
app.get('/robots.txt', (req, res) => res.type('text/plain').send(AI_ROBOTS_TXT));

// Visitor traffic log: fire-and-forget on real page navigations (a browser GET
// for HTML), never on /api, assets, robots.txt or /admin. Runs before the API
// gates + static so the "/" landing (served by express.static) is still counted;
// bot-filtered UAs already got a 403 above and never reach here. Best-effort -
// the insert is not awaited and swallows its own errors.
app.use((req, res, next) => {
    if (shouldLogVisit({ method: req.method, path: req.path, accept: req.get('accept') })) {
        logVisit(visitRowFromReq(req));
    }
    next();
});

// Recognized machine bearer secrets: routes own their auth (requireAdmin,
// requireAdminDual), but the blanket /api gates below must not 401 those
// clients before their route's own check runs. One list, both gates - never a
// per-path allow-list (H2). bearerMatches skips unset entries.
const MACHINE_BEARERS = [config.API_TOKEN, config.ADMIN_TOKEN];

// Same-origin CSRF guard shared by every state-changing route: custom headers
// force a CORS preflight cross-origin, which this server never approves - only
// same-origin callers can set X-Requested-With. Answers the 403 itself; callers
// bail on false. (C1: one copy - auth/admin routes, refresh.)
const csrfOk = (req, res) => {
    if (req.get('x-requested-with')) return true;
    res.status(403).json({ error: 'Missing X-Requested-With header.' });
    return false;
};

// Optional bearer-token guard: X-Requested-With (below) only stops a plain
// cross-origin form/navigation - once this server is on a public domain,
// anyone who finds the URL could POST /api/refresh directly (triggers live
// scrapes/API-Football calls). Unset by default - zero effect on today's
// LAN-only (API_HOST=127.0.0.1) deployment.
if (config.API_TOKEN) {
    app.use('/api', (req, res, next) => {
        if (bearerMatches(req.get('authorization'), MACHINE_BEARERS)) return next();
        res.status(401).json({ error: 'Unauthorized' });
    });
}

// NOTE: the stateless proof-of-work human gate (/api/challenge, /api/human,
// HUMAN_POW_*) was removed 2026-07-16 - deprecated as irrelevant at this stage.
// It was opt-in and off by default, so removal is a no-op for every deployment.
// The bot-UA blocklist above + the AI robots.txt below are a SEPARATE feature
// and remain in force.

// ============================================================================
// User accounts + sessions (v1.1.0). Opaque hashed DB sessions carried as
// `Authorization: Bearer`; role-aware guards; per-route JSON + the same
// X-Requested-With CSRF guard as /api/refresh. Logic lives in src/auth.js /
// src/auth-rules.js / src/authlimit-rules.js.
// ============================================================================
const bearerToken = req => {
    const a = req.get('authorization') || '';
    return a.startsWith('Bearer ') ? a.slice(7) : null;
};

// Session guard factory. role: require that role; verified: require a verified
// phone. optionalAuth attaches req.user when a valid session is present but
// never rejects (guest-aware routes).
function authGuard({ role, verified } = {}) {
    return async (req, res, next) => {
        try {
            const ctx = await resolveSession(bearerToken(req));
            if (!ctx) return res.status(401).json({ error: 'Sign in required', auth_required: true });
            // Forced PIN change (H4): a default-PIN session may only change its
            // PIN, log out, or read /me until it does (pure mustChangePinBlocks).
            if (ctx.user.must_change_pin && mustChangePinBlocks(req.method, req.path)) {
                return res.status(403).json({ error: 'Change your PIN to continue', pin_change_required: true });
            }
            if (role && ctx.user.role !== role) return res.status(403).json({ error: 'Forbidden' });
            if (verified && !ctx.user.phone_verified) {
                return res.status(403).json({ error: 'Verify your phone number to continue', verify_required: true });
            }
            req.user = ctx.user;
            req.session = ctx.session;
            next();
        } catch (e) { next(e); }
    };
}
const requireAuth = authGuard();
const requireAdminRole = authGuard({ role: 'admin' });
const requireVerified = authGuard({ verified: true });
async function optionalAuth(req, res, next) {
    try {
        // Feature off = no session lookup at all (an API_TOKEN bearer would
        // miss the sessions table on every request for nothing).
        if (config.AUTH_ENABLED) {
            const ctx = await resolveSession(bearerToken(req));
            if (ctx) { req.user = ctx.user; req.session = ctx.session; }
        }
        next();
    } catch (e) { next(e); }
}

// Best-effort in-memory rate limit (DB lockout/cooldown are authoritative -
// trust proxy=true makes IP keys spoofable; see src/authlimit-rules.js).
// Bounded so spoofed keys can't grow the map without limit.
const _rlHits = new Map();
function rateLimit(key, opts) {
    if (_rlHits.size > 10_000) _rlHits.clear();
    const r = slidingWindowAllow(_rlHits.get(key), Date.now(), opts);
    _rlHits.set(key, r.hits);
    return r;
}

// Map an AuthError / ZodError to a JSON response; anything else -> next(e).
function authErr(e, res, next) {
    if (e instanceof AuthError) return res.status(e.status).json({ error: e.message, ...e.details });
    if (e?.name === 'ZodError') return res.status(400).json({ error: e.issues?.[0]?.message || 'Invalid input' });
    next(e);
}
const authJson = express.json({ limit: '4kb' });

if (config.AUTH_ENABLED) {
    // Create account (role=normal) + session, then send the phone-verify OTP.
    app.post('/api/auth/signup', authJson, async (req, res, next) => {
        if (!csrfOk(req, res)) return;
        try {
            const ip = req.ip || null;
            const rl = rateLimit(`signup:${ip}`, { windowMs: 3_600_000, max: 10 });
            if (!rl.allowed) return res.status(429).json({ error: 'Too many sign-up attempts - try again later.', retry_after_seconds: rl.retryAfterSeconds });
            const data = signupSchema.parse(req.body);
            const user = await createUser(data);
            const token = await mintSession(user, { userAgent: req.get('user-agent'), ip });
            // The account + session already exist - an OTP/SMS failure must not
            // 500 the signup (the retry would 409 "already registered"). Answer
            // 201 with otp.sent:false; the verify screen offers resend (M2).
            let otp;
            try {
                otp = await issueOtp(user, {});
            } catch (e) {
                console.error(`[auth] signup OTP send failed for user ${user.id}: ${e.message || e}`);
                otp = { sent: false, error: 'send_failed' };
            }
            res.status(201).json({ token, user: publicUser(user), otp });
        } catch (e) { authErr(e, res, next); }
    });

    // Sign in. user.phone_verified may be false -> the client shows the verify gate.
    app.post('/api/auth/login', authJson, async (req, res, next) => {
        if (!csrfOk(req, res)) return;
        try {
            const { phone, pin } = loginSchema.parse(req.body);
            const rl = rateLimit(`login:${phone}`, { windowMs: 900_000, max: 10 });
            if (!rl.allowed) return res.status(429).json({ error: 'Too many attempts - try again later.', retry_after_seconds: rl.retryAfterSeconds });
            const user = await authenticate({ phone, pin });
            const token = await mintSession(user, { userAgent: req.get('user-agent'), ip: req.ip });
            res.json({ token, user: publicUser(user) });
        } catch (e) { authErr(e, res, next); }
    });

    app.post('/api/auth/verify-otp', requireAuth, authJson, async (req, res, next) => {
        if (!csrfOk(req, res)) return;
        try {
            const { code } = verifyOtpSchema.parse(req.body);
            res.json({ ok: true, user: await verifyOtp(req.user, { code }) });
        } catch (e) { authErr(e, res, next); }
    });

    app.post('/api/auth/resend-otp', requireAuth, authJson, async (req, res, next) => {
        if (!csrfOk(req, res)) return;
        try { res.json(await resendOtp(req.user, {})); } catch (e) { authErr(e, res, next); }
    });

    app.post('/api/auth/change-phone', requireAuth, authJson, async (req, res, next) => {
        if (!csrfOk(req, res)) return;
        try {
            // Belt-and-suspenders over the DB-authoritative OTP issue-gate
            // (auth.js otpGate): a user-keyed burst limit - the key comes from
            // the session, so unlike IP keys it can't be spoofed.
            const rl = rateLimit(`chphone:${req.user.id}`, { windowMs: 900_000, max: 5 });
            if (!rl.allowed) return res.status(429).json({ error: 'Too many phone changes - try again later.', retry_after_seconds: rl.retryAfterSeconds });
            const data = changePhoneSchema.parse(req.body);
            res.json({ ok: true, ...(await changePhone(req.user, data)) });
        } catch (e) { authErr(e, res, next); }
    });

    app.post('/api/auth/logout', requireAuth, authJson, async (req, res, next) => {
        if (!csrfOk(req, res)) return;
        try {
            if (req.body?.all) await revokeAllForUser(req.user.id);
            else await revokeSession(req.session.id);
            res.json({ ok: true });
        } catch (e) { authErr(e, res, next); }
    });

    app.get('/api/auth/me', requireAuth, (req, res) => {
        res.json({ user: publicUser(req.user), session: { id: req.session.id, expires_at: req.session.expires_at } });
    });

    app.put('/api/auth/profile', requireVerified, authJson, async (req, res, next) => {
        if (!csrfOk(req, res)) return;
        try {
            const data = profileSchema.parse(req.body);
            res.json({ ok: true, user: await updateProfile(req.user, data) });
        } catch (e) { authErr(e, res, next); }
    });

    // ------------------------------------------------------------------------
    // Cross-device prefs sync (Phase 7). One blob per user; LWW protocol in
    // src/db/prefs-rules.js, conditional write in src/prefs.js. requireAuth
    // (not requireVerified) - prefs are harmless and syncing shouldn't wait
    // on the phone gate. No-row GET answers version 0 so the client's
    // reconcile() sees "no server copy yet" and pushes local (first login).
    app.get('/api/prefs', requireAuth, async (req, res, next) => {
        try {
            const row = await getUserPrefs(req.user.id);
            res.json(row ?? { data: null, version: 0, updated_at: null });
        } catch (e) { next(e); }
    });

    // PUT { data, version } -> { version, updated_at } | 409 { conflict, server }.
    // The body is sanitized server-side too (device keys / foreign keys never
    // persist, whatever a client claims); a stale-version write loses and gets
    // the winning row back to reconcile against.
    app.put('/api/prefs', requireAuth, express.json({ limit: '64kb' }), async (req, res, next) => {
        if (!csrfOk(req, res)) return;
        try {
            const v = validatePrefsPut(req.body);
            if (!v.ok) return res.status(400).json({ error: v.error });
            const out = await saveUserPrefs(req.user.id, v.data, v.version);
            if (out.conflict) {
                return res.status(409).json({ error: 'A newer version exists.', conflict: true, server: out.conflict });
            }
            res.json({ version: out.version, updated_at: out.updated_at, dropped: v.dropped });
        } catch (e) { next(e); }
    });
}

// Parse a JSON-encoded query param (sort/filters), tolerating absence
function _json(value, fallback) {
    if (value == null || value === '') return fallback;
    try {
        return JSON.parse(value);
    } catch {
        throw new TypeError(`Invalid JSON query param: ${value}`);
    }
}

// Server-side response memo for the heavy read endpoints (src/http-cache.js):
// keyed on the auto-refresh data_version, so entries invalidate the moment a
// refresh SUCCEEDS (the only time query results actually change); the TTL is
// the belt for out-of-process writers. Repeated hits skip queryRecords /
// columnCatalog entirely and reuse the serialized+gzipped body; a matching
// If-None-Match answers 304 with no body at all.
const apiCache = makeJsonCache({
    max: 12, ttlMs: 10 * 60_000,
    version: () => refreshStatus().data_version,
});

// GET /api/columns - column catalog (base + markets + stats) for settings UI
app.get('/api/columns', async (req, res, next) => {
    try {
        await apiCache.send(req, res, '/api/columns', () => columnCatalog());
    } catch (e) {
        next(e);
    }
});

// GET /api/records?date=YYYY-MM-DD&page=&per_page=&sort=[{key,dir}]&filters=[{key,op,value}]
// date defaults to today; pass date=all for every date.
//
// Guest-vs-normal gating (Phase 8, server authoritative - pure rules in
// src/db/access-rules.js): with AUTH_ENABLED, a request without a valid
// session is a guest - future dates 403, the all-dates view stops at today,
// and rows lose the internal reasoning (tip_breakdown / AI reasons / exact
// confidence). Machine bearers (API_TOKEN/ADMIN_TOKEN) stay full-access like
// AUTH_ENABLED=0 installs: access=null = the legacy behavior, untouched.
app.get('/api/records', optionalAuth, async (req, res, next) => {
    try {
        const { date, page, per_page, sort, filters, completed, providers } = req.query;
        // Normalize the date for the cache key so absent/'today'/'now' hit the
        // same slot as the explicit YYYY-MM-DD the web client sends.
        const day = date === 'all' ? 'all' : _dtime(date || new Date()).slice(0, 10);
        const access = config.AUTH_ENABLED && !bearerMatches(req.get('authorization'), MACHINE_BEARERS)
            ? accessFromUser(req.user)
            : null;
        if (access && !access.canFuture && !guestDateAllowed(day, _dtime(new Date()).slice(0, 10))) {
            return res.status(403).json({ error: 'Sign in to see upcoming games.', auth_required: true });
        }
        // The response memo key MUST carry the access tier - a guest
        // (redacted, date-clamped) body and a full one can never share a
        // slot, or one tier would be served the other's cached payload.
        const tier = access && !access.fullDetail ? 'guest' : 'full';
        const key = queryCacheKey('/api/records', { ...req.query, date: day, tier });
        await apiCache.send(req, res, key, () => queryRecords({
            date: date === 'all' ? null : (date || new Date()),
            page,
            per_page: per_page === 'all' ? 'all' : per_page,
            sort: _json(sort, []),
            filters: _json(filters, []),
            completed: completed !== '0', // ?completed=0 hides concluded games
            providers: providers ? String(providers).split(',').filter(Boolean) : null,
            access,
        }));
    } catch (e) {
        next(e);
    }
});

// GET /api/hotpicks - over 2.5 hot-pick accuracy windows + upcoming hot list
app.get('/api/hotpicks', async (req, res, next) => {
    try {
        res.json(await hotpicksSummary());
    } catch (e) {
        next(e);
    }
});

// GET /api/performance - flat-stake ROI / hit-rate / bucket report for tips
// and hot picks (windows, confidence/market/edge buckets, AI-veto impact)
app.get('/api/performance', async (req, res, next) => {
    try {
        res.json(await performanceSummary());
    } catch (e) {
        next(e);
    }
});

// GET /api/magic-sort - top tip-ranking strategies by 4-leg slip survival
// (backtest over settled tips) + the live calibration the web table scores
// today's rows with. Cached per day; ?refresh=1 recomputes. Deliberately NOT
// response-memoized (its safe policy is late-read per response - M6); the
// stateless sendJson still saves the wire via 304 + gzip.
app.get('/api/magic-sort', async (req, res, next) => {
    try {
        await sendJson(req, res, await magicSortCached(req.query.refresh === '1'));
    } catch (e) {
        next(e);
    }
});

// GET /api/visits/daily-unique?date= - today's (or a given EAT day's) unique
// visitors + page views for the public status-bar badge. Cheap grouped count;
// no PII returned (just numbers), so it needs no admin token.
app.get('/api/visits/daily-unique', async (req, res, next) => {
    try {
        const date = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date ?? '')) ? req.query.date : null;
        res.json(await dailyUniqueVisitors(date));
    } catch (e) {
        next(e);
    }
});

// Admin guard for the traffic dashboard + its data. Reuses the bearer-token
// mechanism but on a SEPARATE secret (ADMIN_TOKEN, falling back to API_TOKEN) so
// a public SPA doesn't have to expose it. The token is ONLY accepted in the
// Authorization header - never a query string (which leaks into logs, browser
// history and Referer). 404 when no admin secret is configured (feature off).
const adminSecret = () => config.ADMIN_TOKEN || config.API_TOKEN || null;
// One admin-bearer check shared by requireAdmin and requireAdminDual (C1) -
// false when no admin secret is configured (a blank secret never matches).
const adminBearerOk = req => {
    const secret = adminSecret();
    return Boolean(secret && bearerMatches(req.get('authorization'), [secret]));
};
function requireAdmin(req, res, next) {
    if (!adminSecret()) return res.status(404).json({ error: 'Admin dashboard not configured (set ADMIN_TOKEN).' });
    if (adminBearerOk(req)) return next();
    return res.status(401).json({ error: 'Unauthorized' });
}

// GET /api/visits/summary - full traffic aggregates for the admin dashboard.
app.get('/api/visits/summary', requireAdmin, async (req, res, next) => {
    try {
        res.json(await visitsSummary());
    } catch (e) {
        next(e);
    }
});

// Dynamic settings (v1.1.0). Admin routes accept EITHER an admin-role session
// (the new SPA admin) OR the legacy ADMIN_TOKEN bearer (the traffic dashboard) -
// a transitional dual-auth. The public subset (SAFE_* etc.) is open like
// /api/magic-sort already is.
async function requireAdminDual(req, res, next) {
    if (adminBearerOk(req)) return next();
    try {
        const ctx = await resolveSession(bearerToken(req));
        if (ctx && ctx.user.role === 'admin') {
            // Same forced-PIN-change gate as authGuard (H4) - the seeded
            // default-PIN admin must not drive the admin API either.
            if (ctx.user.must_change_pin && mustChangePinBlocks(req.method, req.path)) {
                return res.status(403).json({ error: 'Change your PIN to continue', pin_change_required: true });
            }
            req.user = ctx.user; req.session = ctx.session; return next();
        }
    } catch (e) { return next(e); }
    return res.status(401).json({ error: 'Admin access required', auth_required: true });
}

// GET /api/settings - public effective subset (client-safe operational knobs).
app.get('/api/settings', (req, res) => res.json(publicSettings()));

// GET /api/admin/settings - full catalog with default/override/effective/live.
app.get('/api/admin/settings', requireAdminDual, (req, res) => res.json({ settings: adminSettings() }));

// PUT /api/admin/settings - set one override {key,value} (or {overrides:{...}}).
// All-or-nothing: every key validates BEFORE any write (M7), so a bad key in a
// batch can't leave earlier keys persisted+live behind a 400 response.
app.put('/api/admin/settings', requireAdminDual, express.json({ limit: '8kb' }), async (req, res, next) => {
    if (!csrfOk(req, res)) return;
    try {
        const body = settingsPutSchema.parse(req.body ?? {});
        const userId = req.user?.id ?? null;
        const entries = body.overrides ? Object.entries(body.overrides) : [[body.key, body.value]];
        const results = await setOverrides(entries, userId);
        res.json({ ok: true, results, restart_required: results.filter(r => r.restart_required).map(r => r.key) });
    } catch (e) {
        if (e?.status === 400) return res.status(400).json({ error: e.message });
        authErr(e, res, next); // maps a ZodError to 400 like the auth routes
    }
});

// DELETE /api/admin/settings/:key - reset one override to its config default.
app.delete('/api/admin/settings/:key', requireAdminDual, async (req, res, next) => {
    if (!csrfOk(req, res)) return;
    try {
        res.json({ ok: true, ...(await resetOverride(req.params.key)) });
    } catch (e) {
        if (e?.status === 400) return res.status(400).json({ error: e.message });
        next(e);
    }
});

// Data-viz lab (v1.1.0 Phase 6, admin SESSION only - the SPA admin panel; no
// machine-bearer path, unlike the transitional requireAdminDual above). Raw
// rows never leave the server: /data returns small pre-binned aggregates with
// a minCount guardrail (src/lab.js + pure src/db/lab-rules.js).

// GET /api/admin/lab/features - the fixed feature/outcome catalogs + defaults.
app.get('/api/admin/lab/features', requireAdminRole, (req, res) => {
    res.json({ features: LAB_FEATURES, outcomes: LAB_OUTCOMES, defaults: LAB_DEFAULTS });
});

// GET /api/admin/lab/data?x=&outcome=[&y=&color=&filters=&days=&sample=&min_count=]
// filters is a JSON [{key,op,value}] over feature keys. Unknown keys/ops throw
// TypeError -> the JSON error handler's 400.
app.get('/api/admin/lab/data', requireAdminRole, async (req, res, next) => {
    try {
        const q = req.query;
        res.json(await labData({
            x: q.x != null ? String(q.x) : null,
            y: q.y ? String(q.y) : null,
            color: q.color ? String(q.color) : null,
            outcome: q.outcome != null ? String(q.outcome) : null,
            filters: _json(q.filters, []),
            days: q.days ? Number(q.days) : null,
            sample: q.sample ? Number(q.sample) : undefined,
            minCount: q.min_count ? Number(q.min_count) : undefined,
            topCategories: q.top_categories ? Number(q.top_categories) : undefined,
        }));
    } catch (e) {
        next(e);
    }
});

// Single-slot refresh job state lives in src/auto-refresh.js - one shared
// guard for manual AND scheduled runs: parallel refreshes would deadlock on
// InnoDB delete+insert gap locks (same rule as `_batch` DB-writing
// concurrency 1), and a second sweep of the same date is wasted server hits.

// Per-date MANUAL cooldown: date -> ms timestamp of its last finished manual
// run (success or failure - either way it already spent API quota/scrape
// hits). Blocks re-triggering the SAME date for REFRESH_COOLDOWN_MINUTES;
// other dates are unaffected. Auto runs stamp only the success freshness map
// (auto-refresh.js) - a 10-minute light cadence stamping THIS map would keep
// today permanently on manual cooldown.
const refreshCooldown = new Map();

// POST /api/refresh?date=YYYY-MM-DD - start refreshing a date's data
// (fixtures, results, odds, link, stats). 409 with the in-flight job when one
// is already running (manual or scheduled), 200 {fresh:true} when the date
// was successfully refreshed within REFRESH_CACHE_MINUTES (no re-run), 429
// while that date is on manual cooldown (carries retry_after_seconds).
app.post('/api/refresh', (req, res) => {
    if (!csrfOk(req, res)) return;
    const date = String(req.query.date ?? '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(new Date(date).getTime())) {
        return res.status(400).json({ error: `Invalid refresh date (expected YYYY-MM-DD): ${date}` });
    }
    if (refreshStatus().running) return res.status(409).json(refreshStatus());
    // Cache reuse: a recent successful run (auto or manual) already covered
    // this date - answer "fresh" so the client just reloads what it has.
    const cacheMs = effective('REFRESH_CACHE_MINUTES') * 60_000;
    const freshAt = lastFreshAt(date);
    if (cacheMs > 0 && freshAt && (Date.now() - freshAt) < cacheMs) {
        return res.json({
            ...refreshStatus(),
            fresh: true,
            last_refreshed_at: new Date(freshAt).toISOString(),
        });
    }
    const cooldownMs = effective('REFRESH_COOLDOWN_MINUTES') * 60_000;
    const lastFinished = refreshCooldown.get(date);
    if (cooldownMs > 0 && lastFinished && (Date.now() - lastFinished) < cooldownMs) {
        const retry_after_seconds = Math.ceil((cooldownMs - (Date.now() - lastFinished)) / 1000);
        return res.status(429).json({
            error: `Refresh cooldown active for ${date} - try again in ${Math.ceil(retry_after_seconds / 60)}m.`,
            retry_after_seconds,
        });
    }
    const started = startJob({
        mode: 'manual',
        dates: [date],
        run: (onStep, shouldCancel) => runDateRefresh(date, onStep, shouldCancel),
        // A cancelled run doesn't spend the cooldown, so "Resume" (re-POST) works
        // immediately; a completed/failed run already spent quota, so it does.
        onFinish: job => { if (!job.cancelled) refreshCooldown.set(date, Date.now()); },
    });
    // Race with a scheduler tick claiming the slot between the check above
    // and here - same answer as the up-front running check.
    if (!started) return res.status(409).json(refreshStatus());
    res.status(202).json(refreshStatus());
});

// POST /api/refresh/cancel - cooperatively cancel the in-flight refresh job
// (F3). Same CSRF guard as the trigger. 202 with the job state when a cancel
// was requested, 409 when nothing is running to cancel.
app.post('/api/refresh/cancel', (req, res) => {
    if (!csrfOk(req, res)) return;
    if (!requestCancel()) return res.status(409).json({ error: 'No refresh is running.' });
    res.status(202).json(refreshStatus());
});

// GET /api/refresh - poll the refresh job state + freshness signal
// (data_version bumps on every successful run; last_success carries its
// mode/dates so clients reload only when their loaded date is in scope)
app.get('/api/refresh', (req, res) => res.json(refreshStatus()));

// Admin traffic dashboard shell (public HTML; the data behind it is token-gated
// via requireAdmin). Registered before the static/SPA fallback so /admin doesn't
// resolve to the React index.html.
app.get('/admin', (req, res) => res.type('html').send(ADMIN_HTML));

// Built frontend (npm run build:web) with SPA fallback for non-/api routes.
// index.html is served no-cache so every app load revalidates - the browser
// re-requests it (rather than serving a memory-cached copy), which both picks up
// new deploys AND lets the visit-log middleware record repeat visitors. The
// vite-hashed assets are content-addressed, so they cache immutably for a year
// (a new deploy = new filenames); only index.html revalidates.
// gzip only reaches static requests: the /api/* handlers terminate their own
// responses above without next(), so this middleware never re-compresses the
// API layer's own gzip (http-cache.js).
const dist = path.resolve('web', 'dist');
if (existsSync(dist)) {
    app.use(compression());
    app.use(express.static(dist, {
        maxAge: '1y',
        immutable: true,
        setHeaders: (res, filePath) => {
            if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
        },
    }));
    app.use((req, res, next) => {
        if (req.method !== 'GET' || req.path.startsWith('/api/')) return next();
        res.setHeader('Cache-Control', 'no-cache');
        res.sendFile(path.join(dist, 'index.html'));
    });
}

// JSON error handler: client errors (bad sort/filter/JSON) are 400s
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    const status = err instanceof TypeError ? 400 : 500;
    if (status === 500) console.error(err);
    res.status(status).json({ error: String(err?.message ?? err) });
});

// Optionally self-apply pending schema migrations before serving
// (MIGRATE_ON_BOOT). Off by default - local/dev restarts never migrate. On a
// shell-less shared host (cPanel) there is no terminal to `npm run migrate`, so
// restarting the Node app is the only way to run a new migration; this makes
// the restart do it. Schema-only (knex migrate:latest, forward-only).
async function migrateOnBoot() {
    if (!config.MIGRATE_ON_BOOT) return; // no-op default
    console.debug('[migrate] MIGRATE_ON_BOOT set - running knex migrate:latest...');
    console.debug(`[migrate] ${describeMigrationResult(await db.migrate.latest())}`);
}

let server = null;
(async () => {
    try {
        await migrateOnBoot();
        await loadOverrides();
        server = app.listen(config.API_PORT, config.API_HOST, () => {
            console.debug(`[+] oddspro API listening on http://${config.API_HOST}:${config.API_PORT}`);
            startAutoRefresh();
            startGeoScheduler();
        });
    } catch (err) {
        // Fail fast: don't serve on an uncertain schema (or unloadable
        // overrides). The host surfaces the exit + this log via Passenger; fix
        // the migration and restart.
        console.error('[migrate] boot migration failed - not starting server:', err);
        closeDb().finally(() => process.exit(1));
    }
})();

// Graceful shutdown - stop the scheduler, close the HTTP server and the pool
for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
        stopAutoRefresh();
        stopGeoScheduler();
        if (server) server.close(() => closeDb().finally(() => process.exit(0)));
        else closeDb().finally(() => process.exit(0));
    });
}
