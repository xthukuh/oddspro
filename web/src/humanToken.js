// Check-once human-verification token (localStorage). Minted by the server
// after the PoW gate passes; sent as X-Human-Token on API requests until it
// expires (~1 week). Its presence lets the SPA skip the gate on return visits.
const KEY = 'oddspro.human';

export function getHumanToken() {
    try {
        const raw = localStorage.getItem(KEY);
        if (!raw) return null;
        const { token, exp } = JSON.parse(raw);
        if (!token || !exp || Date.now() > exp) return null; // expired -> re-verify
        return token;
    } catch {
        return null;
    }
}

export function setHumanToken(token, ttlDays) {
    try {
        const exp = Date.now() + Number(ttlDays || 7) * 86_400_000;
        localStorage.setItem(KEY, JSON.stringify({ token, exp }));
    } catch { /* private mode / quota - degrade to re-verifying each load */ }
}

export function clearHumanToken() {
    try { localStorage.removeItem(KEY); } catch { /* ignore */ }
}
