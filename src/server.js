import express from 'express';
import compression from 'compression';
import { existsSync, createReadStream, statSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { queryRecords, columnCatalog } from './db/records.js';
import { hotpicksSummary, performanceSummary } from './hotpicks.js';
import { dailySlipPayload, dailyTimelinePayload } from './daily-slip.js';
import { featureAllowed } from './db/feature-rules.js';
import { isPatToken, patRouteAllowed } from './pat-rules.js';
import { saveUserSlip, listUserSlips, getSlipByCode, deleteUserSlip } from './user-slips.js';
import { createPat, listPats, revokePat, resolvePat } from './pats.js';
import { renderedView, knownStrategy } from './view.js';
import { magicSortCached } from './magic.js';
import { runDateRefresh } from './pipeline.js';
import { refreshStatus, startJob, requestCancel, lastFreshAt, startAutoRefresh, stopAutoRefresh, refreshJob } from './auto-refresh.js';
import { haltRequested, startHaltWatch, stopHaltWatch } from './halt.js';
import { db, closeDb } from './db/connection.js';
import { describeMigrationResult } from './db/migrate-rules.js';
import { dbOverview, dbHealth } from './db-info.js';
import { bearerMatches } from './crypto-utils.js';
import { isBlockedUserAgent, AI_ROBOTS_TXT } from './bot-rules.js';
import { shouldLogVisit, pickIp } from './db/visit-rules.js';
import { visitRowFromReq, logVisit, visitsSummary } from './visits.js';
import { checkinSchema, eventsSchema, checkoutSchema } from './db/track-rules.js';
import { checkin, ingestEvents, checkout, dailyUniqueSessions, trackSummary } from './track.js';
import { startGeoScheduler, stopGeoScheduler } from './geo.js';
import { startAiWorker, stopAiWorker } from './ai-worker.js';
import {
    AuthError, publicUser, createUser, authenticate, mintSession, resolveSession,
    revokeSession, revokeAllForUser, issueOtp, resendOtp, verifyOtp, changePhone, updateProfile,
    forgotPinStart, resetPinWithOtp,
} from './auth.js';
import {
    signupSchema, loginSchema, verifyOtpSchema, changePhoneSchema, profileSchema, mustChangePinBlocks,
    resendOtpSchema, forgotPinSchema, resetPinSchema,
} from './auth-rules.js';
import { slidingWindowAllow } from './authlimit-rules.js';
import { normalizePhone } from './db/sms-rules.js';
import { validatePrefsPut } from './db/prefs-rules.js';
import { accessFromUser, guestDateAllowed } from './db/access-rules.js';
import { getUserPrefs, saveUserPrefs } from './prefs.js';
import { loadOverrides, effective, publicSettings, adminSettings, setOverrides, resetOverride, auditTrail } from './settings.js';
import { settingsPutSchema } from './db/settings-rules.js';
import { listUsers, getAdminUser, patchUser } from './admin-users.js';
import { userPatchSchema } from './db/admin-rules.js';
import { listTemplates, saveTemplate, deleteTemplate } from './sms/templates.js';
import {
    previewCampaign, createCampaign, listCampaigns, getCampaign, getCampaignRecipients,
    sendCampaign, cancelCampaign, campaignJobStatus, requestCampaignCancel,
} from './campaigns.js';
import { templateSchema, campaignCreateSchema, campaignSendSchema } from './db/campaign-rules.js';
import { makeJsonCache, sendJson } from './http-cache.js';
import { queryCacheKey } from './db/cache-rules.js';
import { retryAfterSeconds } from './db/maintenance-rules.js';
import { maintenanceNow } from './maintenance.js';
import { _dtime } from './utils.js';

// Visualization API server (:3001). Serves the paginated/multi-sort/filtered
// records endpoint over the warehouse plus the column catalog for the web
// settings modal, and the built web/dist frontend when present.
// Start with `npm run serve`; the vite dev server proxies /api/* here.

const app = express();
app.disable('x-powered-by');
// Behind cPanel/Passenger (or any reverse proxy) the socket peer is the proxy;
// trust it so req.ip / X-Forwarded-For reflect the real visitor (visit logging).
// A HOP COUNT, never `true`: trusting all proxies makes req.ip the leftmost XFF
// entry - which the client supplies - so every IP-keyed rate limit (signup,
// forgot-PIN, reset-PIN, beacons) is bypassed by rotating one header. Signup is
// the one that matters: it is unauthenticated, the caller picks the recipient
// number, and each accepted request spends real SMS credit.
app.set('trust proxy', config.TRUST_PROXY);

// Bot user-agent blocklist (opt-in, BOT_UA_FILTER_ENABLED). Blocks known AI
// scrapers / aggressive crawlers / raw HTTP clients site-wide before any route;
// general search engines are deliberately NOT blocked (landing-page SEO). Tune
// via BOT_UA_EXTRA (add) / BOT_UA_ALLOW (exempt). See src/bot-rules.js.
// Always registered; the flag is late-read per request so the admin override
// applies live (H3) - a disabled filter costs one Map lookup per request.
// The extra/allow lists are ALSO late-read (M6) - computed only after the
// enabled check passes, so an admin edit applies live and a disabled filter
// still costs just the one effective() lookup per request.
const _uaList = s => String(s || '').split(',').map(x => x.trim()).filter(Boolean);
app.use((req, res, next) => {
    if (!effective('BOT_UA_FILTER_ENABLED')) return next();
    const extra = _uaList(effective('BOT_UA_EXTRA'));
    const allow = _uaList(effective('BOT_UA_ALLOW'));
    if (isBlockedUserAgent(req.get('user-agent') || '', { extra, allow })) {
        return res.status(403).type('text/plain').send('Forbidden');
    }
    next();
});
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

// Recognized machine bearer secrets: routes own their auth (adminBearerOk /
// requireAdminDual), but the blanket /api gates below must not 401 those
// clients before their route's own check runs. One list, both gates - never a
// per-path allow-list (H2). bearerMatches skips unset entries.
const MACHINE_BEARERS = [config.API_TOKEN, config.ADMIN_TOKEN];

// ============================================================================
// Scheduled maintenance gate (M14, spec decision 17). The settings-catalog
// window (group `maintenance`, all live) is read per request; while the state
// is 'active' every request answers 503 UNLESS it is an admin session, a
// machine bearer, or /api/auth/* (an admin must be able to sign in mid-window).
// /api/* gets the JSON body + Retry-After the client's 503 interception feeds
// on; page loads get a self-contained static notice (dev/Express topology only
// - prod Apache serves the SPA regardless, where the CLIENT-side switch is the
// real surface). Cost while off: one effective() Map lookup (bot-filter idiom);
// past-end auto-expiry lives in the pure state machine, never here.
// ============================================================================
// maintenanceNow now lives in src/maintenance.js so the schedulers can share
// the same definition (the quiesce policy is documented there).

// HTML-escape anything admin-authored before it reaches this page. The
// maintenance message is free text validated only by MAINT_MSG_PATTERN, which
// closes the ${...} placeholder set but deliberately permits ordinary
// punctuation - including < and >. Unescaped, a stored <script> would run
// same-origin in EVERY visitor's browser for the length of the window, and
// session tokens live in localStorage. The React overlay is safe (auto-escaped);
// this string template was the only unescaped sink in M14.
const escHtml = s => String(s ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

// Self-contained 503 page: rendered notice + window, meta-refresh so a parked
// tab recovers on its own shortly after the window ends. No external assets -
// the SPA (and its theme tokens) is exactly what may be mid-deploy.
const maintenanceHtml = info => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="60">
<title>Odds Pro - scheduled maintenance</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
    font:15px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
    background:#1A191D;color:#EDEBE8;text-align:center}
  main{max-width:26rem;padding:2rem}
  h1{font-size:1.15rem;margin:0 0 .75rem}
  p{margin:.4rem 0;color:#B6B3AE}
  .w{color:#17C9BA;font-weight:600}
</style></head><body><main>
<h1>Scheduled maintenance</h1>
<p>${escHtml(info.message)}</p>
<p class="w">Back by ${escHtml(info.end)} EAT</p>
<p>This page retries automatically.</p>
</main></body></html>`;

app.use(async (req, res, next) => {
    if (!effective('MAINTENANCE_SCHEDULED')) return next(); // one Map lookup while off
    const info = maintenanceNow();
    if (info.state !== 'active') return next();
    if (req.path.startsWith('/api/auth/')) return next();
    if (bearerMatches(req.get('authorization'), MACHINE_BEARERS)) return next();
    try {
        if (config.AUTH_ENABLED) {
            const ctx = await resolveSession(bearerToken(req));
            if (ctx?.user?.role === 'admin') { req.user = ctx.user; req.session = ctx.session; return next(); }
        }
    } catch { /* resolve failure -> treat as guest, fall through to 503 */ }
    res.set('Retry-After', String(retryAfterSeconds(info.end_ms, Date.now())));
    if (req.path.startsWith('/api/')) {
        return res.status(503).json({ error: 'maintenance', maintenance: info });
    }
    res.status(503).type('html').send(maintenanceHtml(info));
});

// Same-origin CSRF guard shared by every state-changing route: custom headers
// force a CORS preflight cross-origin, which this server never approves - only
// same-origin callers can set X-Requested-With. Answers the 403 itself; callers
// bail on false. (C1: one copy - auth/admin routes, refresh.)
// The bare predicate, for callers that answer for themselves (the beacons owe
// the client { ok:true } rather than a 403 - tracking must never surface as an
// app error). csrfOk keeps writing the 403 for everyone else.
const hasCsrfHeader = req => Boolean(req.get('x-requested-with'));
const csrfOk = (req, res) => {
    if (hasCsrfHeader(req)) return true;
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
            const bearer = bearerToken(req);
            if (isPatToken(bearer)) {
                // Personal access token (Phase 2): resolves to the OWNING
                // user's tier but is READ-ONLY and never admin/auth - the
                // route-matrix lives in pure pat-rules. An unknown/revoked/
                // expired PAT degrades to guest, the invalid-session idiom.
                if (!patRouteAllowed(req.method, req.path)) {
                    return res.status(403).json({ error: 'This access token is read-only.' });
                }
                const ctx = await resolvePat(bearer);
                if (ctx) { req.user = ctx.user; req.pat = ctx.pat; }
            } else {
                const ctx = await resolveSession(bearer);
                if (ctx) { req.user = ctx.user; req.session = ctx.session; }
            }
        }
        next();
    } catch (e) { next(e); }
}

// Best-effort in-memory rate limit. The DB lockout/cooldown stay authoritative;
// this is the cheap first line (see src/authlimit-rules.js). IP-keyed entries
// are only as trustworthy as TRUST_PROXY - a hop COUNT, never `true`, or the
// client picks its own key.
//
// Bounded, but by EVICTING OLDEST rather than clearing: the previous
// `_rlHits.clear()` meant anyone able to mint 10k distinct keys could wipe every
// in-flight login and OTP counter along with their own, turning the overflow
// guard into the bypass. Map iterates in insertion order, so the head is the
// least-recently-ADDED key (re-setting an existing key keeps its position, so
// this is insertion-order, not true LRU - good enough for a spoofed-key flood,
// which is all it defends against).
const RL_MAX_KEYS = 10_000;
const RL_EVICT_BATCH = 1_000;   // amortize: evict in blocks, not one per call
const _rlHits = new Map();
function rateLimit(key, opts) {
    if (_rlHits.size > RL_MAX_KEYS) {
        let drop = _rlHits.size - RL_MAX_KEYS + RL_EVICT_BATCH;
        for (const k of _rlHits.keys()) {
            _rlHits.delete(k);
            if (--drop <= 0) break;
        }
    }
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
            // Normalize local/national forms (0799..., 799..., 254...) to E.164
            // BEFORE the schema gate, so the rate limiter and the users.phone
            // comparison always see the one canonical form. A phone that can't
            // be normalized passes through unchanged and fails loudly in zod.
            const normalized = normalizePhone(req.body?.phone, { region: effective('SMS_DEFAULT_REGION') });
            const { phone, pin } = loginSchema.parse({ ...req.body, phone: normalized ?? req.body?.phone });
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

    // M13: an optional { email } requests the email channel (typed addresses
    // are captured onto the account - pure emailFallbackTarget). A plain SMS
    // resend may answer { delivery_failed:true } instead of sending, steering
    // the client to the email input.
    app.post('/api/auth/resend-otp', requireAuth, authJson, async (req, res, next) => {
        if (!csrfOk(req, res)) return;
        try {
            // User-keyed burst limit (session-derived, unspoofable), matching
            // pin-change-otp. The DB cooldown is authoritative for SENDS, but
            // the delivery_failed early-return deliberately does NOT advance
            // that clock - so without this belt the route stays spinnable and
            // each spin costs up to one outbound delivery-report call.
            const rl = rateLimit(`resend:${req.user.id}`, { windowMs: 900_000, max: 8 });
            if (!rl.allowed) return res.status(429).json({ error: 'Too many code requests - try again later.', retry_after_seconds: rl.retryAfterSeconds });
            const { email } = resendOtpSchema.parse(req.body ?? {});
            res.json(await resendOtp(req.user, { email }));
        } catch (e) { authErr(e, res, next); }
    });

    // M13 critical-change auth: request the PIN-change confirmation code
    // (purpose='pin_change'; consumed by PUT /api/auth/profile). requireAuth,
    // not requireVerified - the forced-PIN-change rescue path may carry an
    // admin-manually-verified phone, but a plain unverified user hits the
    // verify gate before ProfileView anyway. resendOtp owns issue-vs-resend.
    app.post('/api/auth/pin-change-otp', requireAuth, authJson, async (req, res, next) => {
        if (!csrfOk(req, res)) return;
        try {
            // User-keyed burst limit (session-derived, unspoofable) on top of
            // the DB-authoritative cooldown - same belt as change-phone.
            const rl = rateLimit(`pinotp:${req.user.id}`, { windowMs: 900_000, max: 8 });
            if (!rl.allowed) return res.status(429).json({ error: 'Too many code requests - try again later.', retry_after_seconds: rl.retryAfterSeconds });
            const { email } = resendOtpSchema.parse(req.body ?? {});
            res.json(await resendOtp(req.user, { purpose: 'pin_change', email }));
        } catch (e) { authErr(e, res, next); }
    });

    // M13 Forgot PIN (unauthenticated): send/re-send the reset code. Answers
    // stay generic for unknown phones (no cheap existence oracle); the email
    // channel targets ONLY the account's stored address.
    app.post('/api/auth/forgot-pin', authJson, async (req, res, next) => {
        if (!csrfOk(req, res)) return;
        try {
            const ip = req.ip || null;
            const rlIp = rateLimit(`forgot:ip:${ip}`, { windowMs: 3_600_000, max: 15 });
            if (!rlIp.allowed) return res.status(429).json({ error: 'Too many reset requests - try again later.', retry_after_seconds: rlIp.retryAfterSeconds });
            const normalized = normalizePhone(req.body?.phone, { region: effective('SMS_DEFAULT_REGION') });
            const data = forgotPinSchema.parse({ ...req.body, phone: normalized ?? req.body?.phone });
            const rl = rateLimit(`forgot:${data.phone}`, { windowMs: 900_000, max: 6 });
            if (!rl.allowed) return res.status(429).json({ error: 'Too many reset requests - try again later.', retry_after_seconds: rl.retryAfterSeconds });
            res.json(await forgotPinStart(data));
        } catch (e) { authErr(e, res, next); }
    });

    // M13 Forgot PIN completion: code + new PIN -> fresh session (auto
    // sign-in; every prior session is revoked in the service transaction).
    app.post('/api/auth/reset-pin', authJson, async (req, res, next) => {
        if (!csrfOk(req, res)) return;
        try {
            const ip = req.ip || null;
            const rl = rateLimit(`resetpin:${ip}`, { windowMs: 900_000, max: 10 });
            if (!rl.allowed) return res.status(429).json({ error: 'Too many attempts - try again later.', retry_after_seconds: rl.retryAfterSeconds });
            const normalized = normalizePhone(req.body?.phone, { region: effective('SMS_DEFAULT_REGION') });
            const data = resetPinSchema.parse({ ...req.body, phone: normalized ?? req.body?.phone });
            res.json(await resetPinWithOtp(data, { userAgent: req.get('user-agent'), ip }));
        } catch (e) { authErr(e, res, next); }
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

// A5 pre-warm: the column catalog is identical for every user but costs ~2s
// cold (market discovery over odds_markets), and the memo invalidates on
// every data_version bump - without this, that recompute lands on the first
// user after each refresh. A 30s tick keeps the slot warm (the freshness
// contract makes same-version-within-TTL warms free); app-update busting is
// inherent (in-process memo dies on the deploy restart, ETags hash the
// body). Per-DATE payloads (/api/records) deliberately stay demand-computed:
// availability varies by date and tier, so those entries are keyed per
// (date, tier, version) and warming every combination would be waste.
let catalogWarmTimer = null;
function startCatalogWarm() {
    if (catalogWarmTimer) return;
    const warm = () => apiCache.warm('/api/columns', () => columnCatalog())
        .catch(e => console.warn(`[warm] /api/columns failed: ${e?.message ?? e}`));
    catalogWarmTimer = setInterval(warm, 30_000);
    catalogWarmTimer.unref?.();
    warm(); // boot: pay the cold compute now, not on the first user request
}
function stopCatalogWarm() {
    if (!catalogWarmTimer) return;
    clearInterval(catalogWarmTimer);
    catalogWarmTimer = null;
}

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
        const { date, page, per_page, sort, filters, completed, providers, markets } = req.query;
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
        // Key on the params that actually CHANGE the body, not on req.query
        // wholesale: spreading the raw query let `?nonce=1,2,3...` mint endless
        // distinct keys, each forcing a cold compute and evicting the 12-slot
        // LRU (including the warmed column catalog). Anything not listed here
        // is ignored by queryRecords, so it must not shard the cache either.
        const key = queryCacheKey('/api/records', {
            date: day, tier, page, per_page, sort, filters, completed, providers, markets,
        });
        await apiCache.send(req, res, key, () => queryRecords({
            date: date === 'all' ? null : (date || new Date()),
            page,
            per_page: per_page === 'all' ? 'all' : per_page,
            sort: _json(sort, []),
            filters: _json(filters, []),
            completed: completed !== '0', // ?completed=0 hides concluded games
            providers: providers ? String(providers).split(',').filter(Boolean) : null,
            access,
            // ?markets=all bypasses the catalog pivot allow-list (full pre-trim
            // payload); the req.query spread above already keys the cache on it.
            markets: markets === 'all' ? 'all' : null,
        }));
    } catch (e) {
        next(e);
    }
});

// GET /api/hotpicks - over 2.5 hot-pick accuracy windows + upcoming hot list.
// Memoized like /api/columns: it is a full scan of the prediction ledger, was
// unauthenticated and uncached, and a modest concurrent flood could therefore
// saturate the knex pool (DB_POOL_MAX is 3 on the shared host) and stall MySQL
// for the whole app. data_version-keyed, so a refresh still invalidates it.
app.get('/api/hotpicks', async (req, res, next) => {
    try {
        await apiCache.send(req, res, '/api/hotpicks', () => hotpicksSummary());
    } catch (e) {
        next(e);
    }
});

// Daily MultiBet (engine-v2, spec 2026-08-06-0100). Premium seam v1: guests
// get a TEASER (day mood/counts/streaks, no legs, no reasoning); signed-in
// users get the full card. Machine bearers and AUTH_ENABLED=0 stay legacy
// full-access, the /api/records access idiom.
function _dailySlipFull(req) {
    if (!config.AUTH_ENABLED) return true;
    if (bearerMatches(req.get('authorization'), MACHINE_BEARERS)) return true;
    return featureAllowed(req.user ?? null, 'daily_multibet');
}
const _slipTeaser = s => s && ({
    date: s.date, status: s.status, mood: s.mood, legs_total: s.legs_total,
    legs_hit: s.legs_hit, cards_total: s.cards_total, cards_won: s.cards_won,
    combined_odds: s.combined_odds, outcome: s.outcome,
    backfilled: s.backfilled, teaser: true, auth_required: true,
});

app.get('/api/daily-slip', optionalAuth, async (req, res, next) => {
    try {
        const day = _dtime(req.query.date || new Date()).slice(0, 10);
        const slip = await dailySlipPayload(day);
        if (!slip) return res.json({ date: day, slip: null });
        res.json({ date: day, slip: _dailySlipFull(req) ? slip : _slipTeaser(slip) });
    } catch (e) {
        next(e);
    }
});

app.get('/api/daily-slip/timeline', optionalAuth, async (req, res, next) => {
    try {
        const days = Math.max(1, Math.min(365, parseInt(req.query.days, 10) || 30));
        const t = await dailyTimelinePayload(days);
        if (!_dailySlipFull(req)) t.days = t.days.map(_slipTeaser);
        res.json(t);
    } catch (e) {
        next(e);
    }
});

// GET /api/view - the RENDERED view (Phase 2): the exact dataset the
// signed-in browser shows, computed server-side through the same shared
// pure pipeline (magic-rules verbatim). Full tier only (session, PAT or
// machine bearer) - it mirrors the signed-in table, so a guest teaser
// makes no sense here. Params: date, strategy, safe_only=1, one_of_each=1,
// providers=a,b (also the one-of-each priority order).
app.get('/api/view', optionalAuth, async (req, res, next) => {
    try {
        const full = !config.AUTH_ENABLED || req.user != null
            || bearerMatches(req.get('authorization'), MACHINE_BEARERS);
        if (!full) return res.status(401).json({ error: 'Sign in or use an access token for the rendered view.', auth_required: true });
        const strategy = String(req.query.strategy || 'sure');
        if (!knownStrategy(strategy)) return res.status(400).json({ error: `unknown strategy: ${strategy}` });
        const day = _dtime(req.query.date || new Date()).slice(0, 10);
        res.json(await renderedView({
            date: day,
            strategy,
            safeOnly: req.query.safe_only === '1',
            oneEach: req.query.one_of_each === '1',
            providers: req.query.providers ? String(req.query.providers).split(',').filter(Boolean) : null,
        }));
    } catch (e) {
        next(e);
    }
});

// Shareable user slips (engine-v2 Phase 4). Signed-in only (sessions, not
// PATs - saving is a mutation and PATs are read-only by construction); the
// slip_sharing premium seam gates the by-code load path. Legs are sanitized
// server-side to a closed scalar shape and combined odds recomputed - the
// client's arithmetic is display-only.
app.get('/api/slips', requireAuth, async (req, res, next) => {
    try {
        res.json({ slips: await listUserSlips(req.user.id, Number(req.query.limit) || 100) });
    } catch (e) {
        next(e);
    }
});

app.post('/api/slips', requireAuth, express.json({ limit: '64kb' }), async (req, res, next) => {
    if (!csrfOk(req, res)) return;
    try {
        const { title, legs, source_code } = req.body ?? {};
        const slip = await saveUserSlip({ userId: req.user.id, title, legs, sourceCode: source_code });
        res.json({ ok: true, slip });
    } catch (e) {
        if (e?.status === 400) return res.status(400).json({ error: e.message });
        next(e);
    }
});

app.get('/api/slips/code/:code', requireAuth, async (req, res, next) => {
    try {
        if (!featureAllowed(req.user, 'slip_sharing')) return res.status(403).json({ error: 'Slip sharing is not available.' });
        const slip = await getSlipByCode(req.params.code);
        if (!slip) return res.status(404).json({ error: 'No slip with that code.' });
        res.json({ slip });
    } catch (e) {
        next(e);
    }
});

app.delete('/api/slips/:id', requireAuth, async (req, res, next) => {
    if (!csrfOk(req, res)) return;
    try {
        const n = await deleteUserSlip(req.user.id, Number(req.params.id));
        res.json({ ok: true, deleted: n });
    } catch (e) {
        next(e);
    }
});

// GET /api/performance - flat-stake ROI / hit-rate / bucket report for tips
// and hot picks (windows, confidence/market/edge buckets, AI-veto impact).
// Memoized for the same reason as /api/hotpicks: it scans every tip ever
// recorded into Node memory, and it now backs an admin dashboard widget as
// well as the public report.
app.get('/api/performance', async (req, res, next) => {
    try {
        await apiCache.send(req, res, '/api/performance', () => performanceSummary());
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
// visitors + session count for the public status-bar badge. Cheap grouped
// count; no PII returned (just numbers), so it needs no admin token. Since M2
// this counts the v2 beacon `visit_sessions` (identical on dev and prod - the
// prod SPA is Apache-served, so the legacy middleware `visits` log never fires
// there); dailyUniqueVisitors stays available for legacy-history reads.
app.get('/api/visits/daily-unique', async (req, res, next) => {
    try {
        const date = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date ?? '')) ? req.query.date : null;
        res.json(await dailyUniqueSessions(date));
    } catch (e) {
        next(e);
    }
});

// --- Visitor-tracking v2 beacons (M2) ---------------------------------------
// Public + CSRF-guarded, tiny JSON bodies, best-effort by contract: tracking
// must never break the app, so handler errors fold to { ok:true } (the debug
// log keeps the evidence). optionalAuth links a signed-in check-in to its user.
//
// The CSRF check and the per-IP limit live HERE rather than in each handler:
// previously each route called csrfOk(req) without `res`, so a missing header
// threw inside csrfOk and was swallowed by the catch below - the right outcome
// reached by an exception rather than by intent.
//
// The limit is the real point. X-Requested-With only deters BROWSER-driven
// cross-origin calls; any script sets it. Unlimited, one loop over /visit/checkin
// inserts unbounded rows into visitors + visit_sessions + visitor_devices, none
// of which is pruned by default (TRACK_EVENTS_RETENTION_DAYS defaults to 0 =
// keep forever, and sessions/visitors have no purge at all) - a disk-exhaustion
// vector on a quota'd shared host, plus poisoned analytics. Refusals stay
// { ok:true }: a rate-limited beacon is not the client's problem to report.
const _beacon = (handler, { max = 60 } = {}) => async (req, res) => {
    try {
        if (!hasCsrfHeader(req)) return res.json({ ok: true });
        const rl = rateLimit(`beacon:${req.ip}`, { windowMs: 60_000, max });
        if (!rl.allowed) return res.json({ ok: true });
        res.json(await handler(req));
    } catch (e) {
        console.debug('[track] beacon failed:', e?.message ?? e);
        res.json({ ok: true });
    }
};
// Tighter than the default: a real client checks in on page load, not 60x/min.
app.post('/api/visit/checkin', express.json({ limit: '8kb' }), optionalAuth, _beacon(async req => {
    const body = checkinSchema.parse(req.body ?? {});
    const r = await checkin({
        anonId: body.anon_id,
        ua: req.get('user-agent') || '',
        ip: pickIp(req.headers['x-forwarded-for'], req.socket?.remoteAddress),
        path: body.path ?? null,
        referer: body.referer ?? null,
        userId: req.user?.id ?? null,
    });
    return { ok: true, ...r };
}, { max: 20 }));
app.post('/api/visit/events', express.json({ limit: '8kb' }), _beacon(async req => {
    const body = eventsSchema.parse(req.body ?? {});
    return ingestEvents(body.sid, body.key, body.events);
}));
app.post('/api/visit/checkout', express.json({ limit: '8kb' }), _beacon(async req => {
    const body = checkoutSchema.parse(req.body ?? {});
    return checkout(body.sid, body.key);
}, { max: 20 }));

// Admin machine bearer: a SEPARATE secret (ADMIN_TOKEN, falling back to
// API_TOKEN) so a public SPA doesn't have to expose it. The token is ONLY
// accepted in the Authorization header - never a query string (which leaks
// into logs, browser history and Referer). False when no secret is configured
// (a blank secret never matches) - requireAdminDual's session path still works.
const adminSecret = () => config.ADMIN_TOKEN || config.API_TOKEN || null;
const adminBearerOk = req => {
    const secret = adminSecret();
    return Boolean(secret && bearerMatches(req.get('authorization'), [secret]));
};

// GET /api/visits/summary - LEGACY traffic aggregates (the middleware-logged
// `visits` table). Widened bearer-only -> requireAdminDual (M5) so the SPA
// admin session can read it too until the v2 dashboard reaches parity (M12).
app.get('/api/visits/summary', requireAdminDual, async (req, res, next) => {
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
        res.json({ ok: true, ...(await resetOverride(req.params.key, req.user?.id ?? null)) });
    } catch (e) {
        if (e?.status === 400) return res.status(400).json({ error: e.message });
        next(e);
    }
});

// Personal access tokens (Phase 2). requireAdminDual DELIBERATELY (the
// settings precedent, not the session-only M8+ one): PAT minting is the
// machine-bootstrap path for integrations - an n8n install or Claude's
// grounding reads must be able to mint/rotate via ADMIN_TOKEN without an
// interactive phone+PIN login. The plaintext token appears ONCE, in the
// mint response; audit rows carry only the display prefix.
app.get('/api/admin/pats', requireAdminDual, async (req, res, next) => {
    try {
        res.json({ tokens: await listPats() });
    } catch (e) {
        next(e);
    }
});

app.post('/api/admin/pats', requireAdminDual, express.json({ limit: '2kb' }), async (req, res, next) => {
    if (!csrfOk(req, res)) return;
    try {
        const { user_id, name, expires_days } = req.body ?? {};
        if (!Number.isInteger(user_id) || user_id <= 0) return res.status(400).json({ error: 'user_id required' });
        if (!name || typeof name !== 'string') return res.status(400).json({ error: 'name required' });
        const user = await db('users').where('id', user_id).first('id', 'is_active');
        if (!user || !user.is_active) return res.status(400).json({ error: 'unknown or disabled user' });
        const out = await createPat({
            userId: user_id, name,
            expiresDays: Number(expires_days) > 0 ? Number(expires_days) : null,
            actorId: req.user?.id ?? null,
        });
        res.json({ ok: true, token: out.token, pat: out.pat });
    } catch (e) {
        next(e);
    }
});

app.delete('/api/admin/pats/:id', requireAdminDual, async (req, res, next) => {
    if (!csrfOk(req, res)) return;
    try {
        await revokePat(Number(req.params.id), req.user?.id ?? null);
        res.json({ ok: true });
    } catch (e) {
        next(e);
    }
});

// GET /api/admin/settings/audit - recent dated old->new settings changes (M6).
// Session-only like every NEW admin route (spec guards note) - the legacy
// ADMIN_TOKEN bearer deliberately does not unlock the trail.
app.get('/api/admin/settings/audit', requireAdminRole, async (req, res, next) => {
    try {
        res.json({ audit: await auditTrail({ limit: req.query.limit }) });
    } catch (e) {
        next(e);
    }
});

// (Model triage + data-viz lab admin routes removed 2026-08-07 - the core-
// focus trim; git history has both. Re-add alongside their admin sections.)

// GET /api/admin/track/summary[?days=] - pre-binned visitor/feature analytics
// for the admin Dashboard (M5). Admin SESSION only like the lab: raw rows
// never leave the server (src/track.js#trackSummary aggregates everything).
app.get('/api/admin/track/summary', requireAdminRole, async (req, res, next) => {
    try {
        const days = Math.max(1, Math.min(365, Number(req.query.days) || 30));
        res.json(await trackSummary({ days }));
    } catch (e) {
        next(e);
    }
});

// User management (M8, admin SESSION only like every new admin route). The
// pure guards (src/db/admin-rules.js) reject self-disable/demote, self PIN
// actions, and removing the last active admin; a reset_pin response carries
// the one-time temp PIN (never stored or logged in plaintext).

// GET /api/admin/users[?q=&limit=] - all users + live-session counts.
app.get('/api/admin/users', requireAdminRole, async (req, res, next) => {
    try {
        res.json(await listUsers({ q: req.query.q, limit: req.query.limit }));
    } catch (e) { authErr(e, res, next); }
});

app.get('/api/admin/users/:id', requireAdminRole, async (req, res, next) => {
    try {
        res.json({ user: await getAdminUser(req.params.id) });
    } catch (e) { authErr(e, res, next); }
});

// PATCH /api/admin/users/:id - guarded field changes + one-way actions
// (unlock / force_pin_change / reset_pin). Same-transaction admin_audit rows.
app.patch('/api/admin/users/:id', requireAdminRole, authJson, async (req, res, next) => {
    if (!csrfOk(req, res)) return;
    try {
        const patch = userPatchSchema.parse(req.body ?? {});
        res.json({ ok: true, ...(await patchUser(req.params.id, patch, req.user)) });
    } catch (e) { authErr(e, res, next); }
});

// --- M10: DB overview + health (admin SESSION only like every new admin
// route). Both are read-only GETs, so no csrfOk. Modelled on src/db-info.js's
// header note: nothing else in the codebase queries information_schema or
// knex_migrations, so both loaders go through db.raw().

// GET /api/admin/db/overview - server version, per-table sizes (rows_estimate
// is an InnoDB engine ESTIMATE, never exact - see src/db-info.js), migration
// head/pending, knex pool gauges.
app.get('/api/admin/db/overview', requireAdminRole, async (req, res, next) => {
    try {
        res.json(await dbOverview());
    } catch (e) { next(e); }
});

// GET /api/admin/db/health - SELECT 1 latency + SHOW GLOBAL STATUS uptime/
// threads_connected. dbHealth() itself never throws (a failed check resolves
// to {ok:false, error} so the admin gets a reason instead of a 500).
app.get('/api/admin/db/health', requireAdminRole, async (req, res, next) => {
    try {
        res.json(await dbHealth());
    } catch (e) { next(e); }
});

// (M10 DB export/import routes + M11 admin scorecard route removed
// 2026-08-07 - the core-focus trim. DB transfer is superseded by the SSH
// deploy route (scripts/deploy-remote.js); the scorecard stays available as
// the CLI instrument `node scripts/ai-scorecard.js`. Git history has both.)

// --- M9: SMS templates + broadcast campaigns --------------------------------
// Admin SESSION only (never the machine bearer): these spend real credits and
// message real people, so the actor must be an identified human whose action
// the audit trail can name. Mutations additionally require csrfOk.

app.get('/api/admin/sms/templates', requireAdminRole, async (req, res, next) => {
    try {
        res.json({ templates: await listTemplates() });
    } catch (e) { authErr(e, res, next); }
});

// Express 5 (path-to-regexp v8) dropped the `:id?` optional-parameter form;
// `{/:id}` is its replacement and matches both create (no id) and update.
app.put('/api/admin/sms/templates{/:id}', requireAdminRole, authJson, async (req, res, next) => {
    if (!csrfOk(req, res)) return;
    try {
        const body = templateSchema.parse(req.body ?? {});
        const template = await saveTemplate({ id: req.params.id ?? null, ...body }, req.user?.id ?? null);
        res.json({ ok: true, template });
    } catch (e) { authErr(e, res, next); }
});

app.delete('/api/admin/sms/templates/:id', requireAdminRole, async (req, res, next) => {
    if (!csrfOk(req, res)) return;
    try {
        res.json({ ok: true, ...(await deleteTemplate(req.params.id)) });
    } catch (e) { authErr(e, res, next); }
});

// Preview is a POST because the audience is a structured body, not because it
// mutates - it is read-only and safe to call on every keystroke-debounce.
app.post('/api/admin/sms/preview', requireAdminRole, authJson, async (req, res, next) => {
    if (!csrfOk(req, res)) return;
    try {
        // Same envelope as create (so preview can never validate looser than
        // the real thing); the name is irrelevant here and stubbed.
        const body = campaignCreateSchema.parse({ name: 'preview', ...(req.body ?? {}) });
        res.json(await previewCampaign(body));
    } catch (e) { authErr(e, res, next); }
});

app.get('/api/admin/sms/campaigns', requireAdminRole, async (req, res, next) => {
    try {
        res.json({ ...(await listCampaigns({ limit: req.query.limit })), job: campaignJobStatus() });
    } catch (e) { authErr(e, res, next); }
});

app.get('/api/admin/sms/campaigns/:id', requireAdminRole, async (req, res, next) => {
    try {
        const campaign = await getCampaign(req.params.id);
        res.json({ campaign, ...(await getCampaignRecipients(req.params.id)), job: campaignJobStatus() });
    } catch (e) { authErr(e, res, next); }
});

app.post('/api/admin/sms/campaigns', requireAdminRole, authJson, async (req, res, next) => {
    if (!csrfOk(req, res)) return;
    try {
        const body = campaignCreateSchema.parse(req.body ?? {});
        res.status(201).json({ ok: true, campaign: await createCampaign(body, req.user) });
    } catch (e) { authErr(e, res, next); }
});

// The billable step: typed confirmation + the count the admin approved, which
// the service re-counts server-side and refuses on drift (409).
app.post('/api/admin/sms/campaigns/:id/send', requireAdminRole, authJson, async (req, res, next) => {
    if (!csrfOk(req, res)) return;
    try {
        const body = campaignSendSchema.parse(req.body ?? {});
        res.json({ ok: true, ...(await sendCampaign(req.params.id, body, req.user)) });
    } catch (e) { authErr(e, res, next); }
});

app.post('/api/admin/sms/campaigns/:id/cancel', requireAdminRole, authJson, async (req, res, next) => {
    if (!csrfOk(req, res)) return;
    try {
        res.json({ ok: true, ...(await cancelCampaign(req.params.id)) });
    } catch (e) { authErr(e, res, next); }
});

// Live progress for the send in flight (the web polls this while sending).
app.get('/api/admin/sms/job', requireAdminRole, (req, res) => {
    res.json(campaignJobStatus());
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

// How far a manual refresh may reach. The UI offers today-ish ± a week; the
// generous past window keeps legitimate back-fills of a missed day working
// while still bounding a date-walking loop (each date is a full sweep).
const REFRESH_MAX_AHEAD_DAYS = 7;
const REFRESH_MAX_BEHIND_DAYS = 90;

// POST /api/refresh?date=YYYY-MM-DD - start refreshing a date's data
// (fixtures, results, odds, link, stats). 409 with the in-flight job when one
// is already running (manual or scheduled), 200 {fresh:true} when the date
// was successfully refreshed within REFRESH_CACHE_MINUTES (no re-run), 429
// while that date is on manual cooldown (carries retry_after_seconds).
// requireAuth: this route spends API-Football quota AND scrapes two bookmakers
// from our server IP. Unauthenticated it was free to trigger, and the throttles
// are PER DATE (cache + cooldown), so walking distinct dates missed both -
// steady quota drain plus continuous scraping whose realistic end state is an
// IP ban that kills odds ingestion. Guests have no refresh button anyway.
app.post('/api/refresh', requireAuth, (req, res) => {
    if (!csrfOk(req, res)) return;
    const date = String(req.query.date ?? '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(new Date(date).getTime())) {
        return res.status(400).json({ error: `Invalid refresh date (expected YYYY-MM-DD): ${date}` });
    }
    // Bound the date to what the UI can actually ask for, so one signed-in
    // account cannot walk arbitrary history and defeat the per-date throttles.
    const dayMs = 86_400_000, nowDay = Math.floor(Date.now() / dayMs);
    const offset = Math.floor(new Date(`${date}T00:00:00+03:00`).getTime() / dayMs) - nowDay;
    if (offset > REFRESH_MAX_AHEAD_DAYS || offset < -REFRESH_MAX_BEHIND_DAYS) {
        return res.status(400).json({ error: 'Refresh date is outside the supported range.' });
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
// requireAdminDual: cancelling is inherently an operator action - requestCancel
// targets the SHARED single-slot job, so an anonymous caller could loop this and
// abort every 10-minute light pass, the daily full sweep, and an admin's
// in-flight DB import. The product would silently go stale with nothing in the
// UI to explain it, at zero cost to the attacker.
app.post('/api/refresh/cancel', requireAdminDual, (req, res) => {
    if (!csrfOk(req, res)) return;
    if (!requestCancel()) return res.status(409).json({ error: 'No refresh is running.' });
    res.status(202).json(refreshStatus());
});

// GET /api/refresh - poll the refresh job state + freshness signal
// (data_version bumps on every successful run; last_success carries its
// mode/dates so clients reload only when their loaded date is in scope).
// M14: the maintenance schedule rides this existing 60s poll (decision 17 -
// no new endpoint); clients cache it in oddspro.maintenance and switch on
// their own clock at the window's start.
// Deployed-bundle id, written beside the built assets by the vite build
// (web/dist/build-id.txt). Rides this SAME poll - the M14 no-new-endpoint
// discipline - so clients learn about a deploy on a request they already make.
//
// Distinct from data_version, which tracks WAREHOUSE freshness: that drives a
// silent data reload, this needs a real page reload to pick up new hashed
// assets. Cached with an mtime check (bounded to one stat per 10s) so a
// frontend-only redeploy is noticed WITHOUT restarting the backend - which is
// exactly how this host is updated. Absent file = null = feature off.
const BUILD_ID_FILE = path.resolve('web', 'dist', 'build-id.txt');
let _buildId = { value: null, mtime: 0, checkedAt: 0 };
function deployedBuildId() {
    const now = Date.now();
    if (now - _buildId.checkedAt < 10_000) return _buildId.value;
    _buildId.checkedAt = now;
    try {
        const mtime = statSync(BUILD_ID_FILE).mtimeMs;
        if (mtime !== _buildId.mtime) {
            _buildId.mtime = mtime;
            _buildId.value = readFileSync(BUILD_ID_FILE, 'utf8').trim() || null;
        }
    } catch {
        _buildId.value = null;   // no build stamp (dev, or backend-only deploy)
    }
    return _buildId.value;
}

app.get('/api/refresh', (req, res) => res.json({
    ...refreshStatus(),
    maintenance: maintenanceNow(),
    build: deployedBuildId(),
}));

// Legacy admin dashboard URL -> the SPA admin area (M5, spec decision 14).
// Registered before the static/SPA fallback so /admin doesn't resolve to the
// React index.html directly (the redirect carries the deep-link hash).
app.get('/admin', (req, res) => res.redirect(302, '/#admin'));

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
        // .HALT kill-switch boot gate: refusing to start (exit 1) is what
        // makes the switch stick under Passenger auto-respawn - the respawn
        // loop keeps hitting this refusal until the platform marks the app
        // errored, which is the desired stopped state. Delete .HALT to boot.
        if (haltRequested()) {
            console.error('[halt] .HALT file present in the app root - refusing to start. Delete it to boot.');
            process.exit(1);
        }
        await migrateOnBoot();
        await loadOverrides();
        server = app.listen(config.API_PORT, config.API_HOST, () => {
            console.debug(`[+] oddspro API listening on http://${config.API_HOST}:${config.API_PORT}`);
            startAutoRefresh();
            startGeoScheduler();
            startAiWorker();
            startCatalogWarm();
            startHaltWatch(() => shutdown('halt-file'));
        });
    } catch (err) {
        // Fail fast: don't serve on an uncertain schema (or unloadable
        // overrides). The host surfaces the exit + this log via Passenger; fix
        // the migration and restart.
        console.error('[migrate] boot migration failed - not starting server:', err);
        closeDb().finally(() => process.exit(1));
    }
})();

// ONE graceful shutdown path for signals and the .HALT watcher: stop every
// scheduler, cooperatively cancel a running refresh job (its writers finish
// their current step), give it a bounded grace window, then close and exit.
let shuttingDown = false;
function shutdown(why) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.debug(`[shutdown] ${why} - stopping schedulers and closing...`);
    stopAutoRefresh();
    stopGeoScheduler();
    stopAiWorker();
    stopCatalogWarm();
    stopHaltWatch();
    requestCancel(); // no-op when nothing is running
    // A broadcast must be drained too, not just the refresh job. Its slot is
    // separate, so shutdown used to run straight through a live send: the pool
    // closed under the loop, the campaign row stayed 'sending' with pending
    // ledger rows, and nothing resumes it - canTransition('sending','sending')
    // is false, so the route 409s forever and the only recovery is a NEW
    // campaign that re-sends (and re-bills) everyone already delivered. Asking
    // it to stop shrinks that window to the one SMS in flight.
    requestCampaignCancel();
    const busy = () => refreshJob.running || campaignJobStatus().running;
    const finish = () => {
        if (!server) return void closeDb().finally(() => process.exit(0));
        // server.close() only stops NEW connections and waits for every
        // non-idle one, unbounded: an in-flight export download (hundreds of MB
        // over a slow link) or a Node 18 keep-alive socket would hold the
        // process open forever - so `.HALT`, the lever the deploy docs reach
        // for precisely when cPanel's Stop button fails, would leave a zombie
        // holding :3001 and the DB pool. Close idle sockets, then hard-exit on
        // a deadline. The timer is unref'd but still fires while ref'd sockets
        // keep the loop alive, which is exactly the case that needs it.
        const hard = setTimeout(() => {
            console.error('[shutdown] connections still open after the grace period - exiting anyway.');
            process.exit(0);
        }, HARD_EXIT_MS);
        hard.unref?.();
        server.closeIdleConnections?.();
        server.close(() => {
            clearTimeout(hard);
            closeDb().finally(() => process.exit(0));
        });
    };
    const GRACE_MS = 15_000, POLL_MS = 500, HARD_EXIT_MS = 10_000;
    const deadline = Date.now() + GRACE_MS;
    const wait = setInterval(() => {
        if (!busy() || Date.now() >= deadline) {
            clearInterval(wait);
            finish();
        }
    }, POLL_MS);
    wait.unref?.();
    if (!busy()) {
        clearInterval(wait);
        finish();
    }
}

// Diagnostics of last resort. Node's default on an unhandled rejection is to
// throw and exit - on a host with no SSH that means Passenger silently
// respawns with nothing in the log explaining why. Logging and STAYING UP on a
// rejection is the right trade here: the alternative is an invisible restart
// loop. An uncaught exception has genuinely corrupted state, so that one goes
// through the same graceful path as a signal.
process.on('unhandledRejection', reason => {
    console.error('[fatal] unhandled promise rejection:', reason);
});
process.on('uncaughtException', err => {
    console.error('[fatal] uncaught exception:', err);
    shutdown('uncaughtException');
});

for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => shutdown(signal));
}
