// HTTP-status-carrying error, shared by every service module so the server can
// map failures without a translation table (`authErr` in src/server.js reads
// .status and .details).
//
// It lives HERE rather than in auth.js because auth.js imports src/sms/
// templates.js (for the auth-default template wrap), so a template module
// throwing AuthError would close an import cycle. Modules that already import
// it from auth.js keep working - auth.js re-exports it.
export class AuthError extends Error {
    constructor(status, message, details = {}) {
        super(message);
        this.name = 'AuthError';
        this.status = status;
        this.details = details;
    }
}
