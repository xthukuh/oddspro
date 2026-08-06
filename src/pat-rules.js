// Personal-access-token rules (engine-v2 Phase 2, spec 2026-08-06-0100).
// Crypto-bearing pure module at the src/ root, the auth-rules/crypto-utils
// convention: node:crypto only, zero project imports, offline-testable.
//
// Security invariants (enforced here + src/pats.js + server wiring):
// - only the sha256 of a token is ever stored (the session idiom - a DB leak
//   yields no usable token); the plaintext exists once, in the mint response;
// - PAT bearers are READ-ONLY and NEVER valid on /api/admin/* or /api/auth/*,
//   regardless of the owning user's role - an integration token must not be
//   able to administer the system or mutate the account that owns it.
import { createHash, randomBytes } from 'node:crypto';

export const PAT_PREFIX = 'opat_';
export const PAT_DISPLAY_PREFIX_LEN = 12;   // stored for identification in lists

export const isPatToken = s => typeof s === 'string' && s.startsWith(PAT_PREFIX);

export const hashPatToken = token => createHash('sha256').update(token).digest('hex');

export function mintPat(bytes = 32) {
    const token = PAT_PREFIX + randomBytes(bytes).toString('base64url');
    return { token, hash: hashPatToken(token), prefix: token.slice(0, PAT_DISPLAY_PREFIX_LEN) };
}

// v1 scope model: one implicit 'read' scope. GET only; the admin and auth
// surfaces are excluded wholesale (prefix match on the mounted path).
const DENIED_PREFIXES = ['/api/admin', '/api/auth'];

export function patRouteAllowed(method, path) {
    if (String(method).toUpperCase() !== 'GET') return false;
    const p = String(path ?? '');
    return !DENIED_PREFIXES.some(d => p === d || p.startsWith(`${d}/`) || p.startsWith(`${d}?`));
}
