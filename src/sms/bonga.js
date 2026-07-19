import axios from 'axios';
import { config } from '../config.js';
import { effective } from '../settings.js';
import { toMsisdn, parseBongaSend, parseBongaBalance, parseBongaDelivery } from '../db/sms-rules.js';

// Bonga SMS provider (https://app.bongasms.co.ke). Send is a form POST to the
// send host; balance + delivery are GETs to the app host. Mirrors src/ai.js:
// per-call axios, secrets from config, response validated by the pure zod
// envelopes in sms-rules. Throws on a transport/HTTP failure (the orchestrator
// wraps sends in the shared network retry); a 666 application error comes back
// as { ok:false } for the caller to handle (never retried).
export const name = 'bonga';

// send needs all three creds; balance/delivery only need clientID + key.
function _creds({ needSecret = false } = {}) {
    const { BONGA_API_CLIENT_ID, BONGA_API_KEY, BONGA_API_SECRET } = config;
    if (!BONGA_API_CLIENT_ID || !BONGA_API_KEY || (needSecret && !BONGA_API_SECRET)) {
        // Fail-closed: SMS was requested but the provider isn't configured.
        throw new Error(
            'Bonga SMS not configured (set BONGA_API_CLIENT_ID / BONGA_API_KEY'
            + (needSecret ? ' / BONGA_API_SECRET' : '') + '). See .env.example.',
        );
    }
    return { apiClientID: String(BONGA_API_CLIENT_ID), key: BONGA_API_KEY, secret: BONGA_API_SECRET };
}

export async function send({ to, text }) {
    const { apiClientID, key, secret } = _creds({ needSecret: true });
    // send-sms is documented as form-data, but urlencoded VERIFIED LIVE
    // 2026-07-19: status 222 + DeliveredToTerminal on the vendor send host
    // (unique_id 597538152). Do not switch to multipart without new evidence.
    const body = new URLSearchParams({
        apiClientID,
        key,
        secret,
        txtMessage: text,
        MSISDN: toMsisdn(to),
        serviceID: String(effective('BONGA_SERVICE_ID')),
    });
    const res = await axios.post(config.BONGA_API_URL_SEND, body, {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 20_000,
    });
    return parseBongaSend(res.data);
}

export async function balance() {
    const { apiClientID, key } = _creds();
    const res = await axios.get(config.BONGA_API_URL_BALANCE, {
        params: { apiClientID, key },
        timeout: 20_000,
    });
    return parseBongaBalance(res.data);
}

export async function delivery(messageId) {
    const { apiClientID, key } = _creds();
    const res = await axios.get(config.BONGA_API_URL_DELIVERY, {
        params: { apiClientID, key, unique_id: messageId },
        timeout: 20_000,
    });
    return parseBongaDelivery(res.data);
}
