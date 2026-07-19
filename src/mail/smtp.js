import nodemailer from 'nodemailer';
import { config } from '../config.js';

// SMTP mail provider (nodemailer, exact-pinned). Transport-only, mirroring
// src/sms/bonga.js: creds from config, normalized { ok, messageId, message }
// verdicts, throws on transport failure (the orchestrator owns the shared
// network retry). Laravel-style MAIL_* envs: implicit TLS when MAIL_SCHEME is
// 'smtps' / MAIL_ENCRYPTION is 'ssl' / port 465; STARTTLS is required when
// MAIL_ENCRYPTION is 'tls' (never silently downgrade to cleartext).
export const name = 'smtp';

// Fail-closed: mail was requested but the provider isn't configured. The host
// is THE cred gate (auth-less relays exist); username/password ride together.
function _creds() {
    const { MAIL_HOST, MAIL_USERNAME, MAIL_PASSWORD } = config;
    if (!MAIL_HOST || (MAIL_USERNAME && !MAIL_PASSWORD)) {
        throw new Error('SMTP mail not configured (set MAIL_HOST and, if the server needs auth, MAIL_USERNAME + MAIL_PASSWORD). See .env.example.');
    }
    return { host: MAIL_HOST, username: MAIL_USERNAME, password: MAIL_PASSWORD };
}

let _transport = null; // lazy singleton - config is static for the process life
function _transporter() {
    if (_transport) return _transport;
    const { host, username, password } = _creds();
    const secure = config.MAIL_SCHEME === 'smtps' || config.MAIL_ENCRYPTION === 'ssl' || config.MAIL_PORT === 465;
    _transport = nodemailer.createTransport({
        host,
        port: config.MAIL_PORT,
        secure,
        requireTLS: !secure && config.MAIL_ENCRYPTION === 'tls',
        auth: username ? { user: username, pass: password } : undefined,
        connectionTimeout: 20_000,
        socketTimeout: 20_000,
    });
    return _transport;
}

export async function send({ to, subject, text }) {
    const from = config.MAIL_FROM_ADDRESS || config.MAIL_USERNAME;
    if (!from) throw new Error('SMTP mail not configured (set MAIL_FROM_ADDRESS or MAIL_USERNAME). See .env.example.');
    const info = await _transporter().sendMail({
        from: { name: config.MAIL_FROM_NAME, address: from },
        to, subject, text,
    });
    return { ok: true, messageId: info.messageId ?? null, message: info.response ?? '' };
}
