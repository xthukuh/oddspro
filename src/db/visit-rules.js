// Pure visitor-log rules (zero imports, offline-testable): user-agent parsing,
// client-IP extraction, the "is this a page navigation worth logging?" gate and
// the row builder. No DB / config / express here so node:test covers it like the
// other rule modules.

// Classify the device from a user-agent. Order matters: bots first (many carry
// "Mobile"/"Android"), then tablet before mobile (Android tablets omit "Mobile",
// iPad says "iPad"), then mobile, else desktop.
export function classifyDevice(ua = '') {
    const s = String(ua);
    if (/bot|crawl|spider|slurp|bingpreview|facebookexternalhit|embedly|monitor|curl|wget|python-requests|httpclient|headless|lighthouse|pingdom|uptime/i.test(s)) return 'bot';
    if (/ipad|tablet|playbook|silk|kindle|(android(?!.*mobile))/i.test(s)) return 'tablet';
    if (/mobi|iphone|ipod|android|blackberry|windows phone|opera mini|iemobile/i.test(s)) return 'mobile';
    if (!s) return 'unknown';
    return 'desktop';
}

// Rendering-engine-aware browser sniff. Edge/Opera/Samsung must be checked
// before Chrome (their UAs also contain "Chrome"); Chrome before Safari (Chrome
// UAs contain "Safari").
export function classifyBrowser(ua = '') {
    const s = String(ua);
    if (/edg(a|ios)?\//i.test(s)) return 'Edge';
    if (/opr\/|opera/i.test(s)) return 'Opera';
    if (/samsungbrowser/i.test(s)) return 'Samsung Internet';
    if (/ucbrowser/i.test(s)) return 'UC Browser';
    if (/chrome|crios|chromium/i.test(s)) return 'Chrome';
    if (/firefox|fxios/i.test(s)) return 'Firefox';
    if (/safari/i.test(s)) return 'Safari';
    if (!s) return 'Unknown';
    return 'Other';
}

// OS sniff. Android before Linux (Android UAs contain "Linux"); iOS covers
// iPhone/iPad/iPod; Windows first.
export function classifyOs(ua = '') {
    const s = String(ua);
    if (/windows nt|windows phone/i.test(s)) return 'Windows';
    if (/android/i.test(s)) return 'Android';
    if (/iphone|ipad|ipod|ios /i.test(s)) return 'iOS';
    if (/mac os x|macintosh/i.test(s)) return 'macOS';
    if (/cros/i.test(s)) return 'ChromeOS';
    if (/linux/i.test(s)) return 'Linux';
    if (!s) return 'Unknown';
    return 'Other';
}

export function parseUserAgent(ua = '') {
    return { deviceType: classifyDevice(ua), browser: classifyBrowser(ua), os: classifyOs(ua) };
}

// Strip an IPv6-mapped IPv4 prefix (::ffff:1.2.3.4 -> 1.2.3.4) and any :port.
export function normalizeIp(ip) {
    if (!ip) return null;
    let s = String(ip).trim();
    const m = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
    if (m) s = m[1];
    // IPv4 with :port (not IPv6 which has many colons)
    if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(s)) s = s.split(':')[0];
    return s || null;
}

// Real client IP: the first hop of X-Forwarded-For (set by the reverse proxy /
// cPanel Passenger in prod) if present, else the socket's remote address.
export function pickIp(xff, remoteIp = null) {
    if (xff) {
        const first = String(xff).split(',')[0].trim();
        if (first) return normalizeIp(first);
    }
    return normalizeIp(remoteIp);
}

// Log only real page navigations: a GET that a browser makes for HTML (Accept
// carries text/html), not /api, /robots.txt, /admin or a static asset (a last
// path segment with a file extension). The SPA loads at "/" and extensionless
// routes, so this catches every visitor once without counting assets/XHR.
export function shouldLogVisit({ method, path, accept } = {}) {
    if (method !== 'GET') return false;
    if (!path) return false;
    if (path.startsWith('/api/') || path === '/robots.txt' || path.startsWith('/admin')) return false;
    if (!/text\/html/i.test(accept || '')) return false;
    const last = path.split('/').pop() || '';
    if (last.includes('.')) return false; // e.g. /assets/index-abc.js
    return true;
}

// Assemble a visits row from the extracted request bits. Trims each string to
// its column width; country/region are left unset (resolved later).
export function buildVisitRow({ ip = null, ua = '', referer = null, path = null, now = new Date() } = {}) {
    const { deviceType, browser, os } = parseUserAgent(ua);
    const trim = (s, n) => (s == null || s === '' ? null : String(s).slice(0, n));
    return {
        visited_at: now,
        ip: trim(ip, 45),
        user_agent: trim(ua, 512),
        device_type: deviceType,
        browser,
        os,
        referer: trim(referer, 512),
        path: trim(path, 512),
    };
}
