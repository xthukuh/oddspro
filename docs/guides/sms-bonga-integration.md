# SMS / Bonga Integration (v1.1.0)

Reference for the SMS subsystem that delivers phone-verification OTPs. This
documents the integration only — **live sending is verified manually by the
operator** (see the checklist at the end). Two wire-format details are still
flagged "VERIFY live" and are called out below.

Source: `src/sms/index.js` (provider seam) · `src/sms/bonga.js` (Bonga client) ·
`src/db/sms-rules.js` (pure rules) · `src/auth.js` (OTP orchestration) ·
`src/index.js` (`sms` CLI) · `src/config.js` (env validation).

---

## 1. What it's for

SMS exists for **one purpose: phone-verification OTPs** during signup / phone
change (v1.1.0 auth). It is **OFF by default** — nothing sends until an operator
sets `SMS_ENABLED=1` and supplies Bonga credentials. With SMS disabled the whole
auth flow still works in dev: the code is logged to the server console instead of
being sent, so signup → verify is testable without a Bonga account or spending
credits.

The provider is **swappable**. Bonga is the only implementation today, but the
seam (`getProvider()` in `src/sms/index.js`) is the single swap point — a new
provider just implements `send` / `balance` / `delivery` returning the same
normalized shapes and nothing else changes.

---

## 2. Files & responsibilities

| File | Kind | Responsibility |
|---|---|---|
| `src/db/sms-rules.js` | pure (zod-only, offline-tested) | Phone → MSISDN normalization, OTP generation / expiry / reuse math, resend backoff, Bonga response envelopes (222/666), cleartext-URL detection. No HTTP, no config, no crypto. |
| `src/sms/bonga.js` | provider client | Bonga HTTP calls: `send` (form POST), `balance` / `delivery` (GET). Reads creds from config; validates responses via the pure envelopes. |
| `src/sms/index.js` | provider seam | `getProvider()` swap point, `sendSms/smsBalance/smsDelivery`, dev fallback, shared network retry, one-time cleartext-transport warning. |
| `src/auth.js` | orchestrator | Issues / resends / verifies OTP codes; calls `sendSms`; hashes codes (pepper) into `otp_codes`. |
| `src/index.js` | CLI | `node src/index.js sms <balance | delivery <id> | send <phone> <text>>`. |
| `src/config.js` | validation | zod-validates all `SMS_*` / `BONGA_*` / `OTP_*` env. |

Note: OTP **code hashing** deliberately lives in `src/auth-rules.js` (with the
other `node:crypto` helpers), NOT in `sms-rules.js`, which is kept crypto-free so
the whole SMS/OTP decision surface is unit-tested without a network or account.

---

## 3. End-to-end OTP flow

```
signup / request-code                       verify-code
        │                                        │
        ▼                                        ▼
 auth.issueOtp / resendOtp                auth.verifyOtp
   generateOtp(OTP_LENGTH, crypto.randomInt)   hash(input) == stored code_hash?
   hashOtpCode(code, PIN_PEPPER) ─► otp_codes    ├─ expired?  410
   expires_at = now + OTP_TTL_MINUTES            ├─ attempts >= OTP_MAX_ATTEMPTS? 429
   sendSms({ to: phone, text: otpMessage })      └─ mismatch? 400 (attempts++)
        │
        ▼
 sms/index.sendSms
   SMS_ENABLED off ─► log "[sms:dev] would send …" and return { ok, dev:true }
   SMS_ENABLED on  ─► withRetry(bonga.send)  (3 tries, network errors only)
```

- The **plaintext code is only ever in the SMS body** (`otpMessage`): *"Your Odds
  Pro verification code is NNNNNN. It expires in 10 minutes."* The stored row
  keeps only a salted+peppered hash (`code_hash`), so the DB never holds the code.
- **Reuse economy:** if an unconsumed, unexpired code already exists for the
  phone+purpose, `issueOtp` reuses it (subject to resend cooldown) instead of
  generating and paying for a fresh send (`shouldReuseOtp`).
- **Resend backoff:** grows `OTP_RESEND_BASE_SECONDS · n` → 60, 120, 180, …
  capped at `OTP_MAX_RESENDS`.
- **Verify lockout:** `OTP_MAX_ATTEMPTS` wrong entries force a fresh code.

---

## 4. Behaviour contract

- **Disabled (default):** `sendSms` never hits the network; returns
  `{ ok:true, dev:true, messageId:null }` and logs the would-be message (the code
  is visible in the server console `debug` log for dev verify).
- **Enabled but creds missing:** the Bonga client **fails closed** — it throws a
  clear "Bonga SMS not configured …" error rather than silently "succeeding", so
  the caller surfaces a real error. `send` needs all three creds
  (`CLIENT_ID`+`KEY`+`SECRET`); `balance`/`delivery` need only `CLIENT_ID`+`KEY`.
- **Network vs application errors:** transient transport failures
  (`ECONNRESET`/TLS/etc.) self-heal via the shared retry (3 tries, base 500ms). A
  Bonga **application error (status 666)** comes back as `{ ok:false }` and is
  **never retried** (it won't self-heal).
- **Status codes:** `222` = success, anything else (incl. `666`) = fatal
  application error (`classifyBongaStatus`). Response envelopes are tolerant
  (optional fields, coerced numeric status) so a minor vendor shape-drift doesn't
  throw.

---

## 5. Bonga API surface

All three calls read creds from config and normalize the response via
`src/db/sms-rules.js`.

| Call | Method / URL (env) | Params / body | Needs |
|---|---|---|---|
| `send` | POST `BONGA_API_URL_SEND` | urlencoded: `apiClientID, key, secret, txtMessage, MSISDN, serviceID` | all 3 creds |
| `balance` | GET `BONGA_API_URL_BALANCE` | query: `apiClientID, key` | id+key |
| `delivery` | GET `BONGA_API_URL_DELIVERY` | query: `apiClientID, key, unique_id` | id+key |

**MSISDN** = E.164 **without** the leading `+` (digits only, e.g.
`+254799944004` → `254799944004`). `toMsisdn` validates E.164 first and throws on
a bad number.

Normalized returns:
- `send` → `{ ok, status, message, messageId, credits }`
- `balance` → `{ ok, status, message, clientName, credits, threshold }`
- `delivery` → `{ ok, status, message, deliveryStatus, deliveryStatusDesc }`

---

## 6. Configuration reference

All optional; validated in `src/config.js`. Defaults shown.

| Env | Default | Meaning |
|---|---|---|
| `SMS_ENABLED` | `0` | Master switch. Off ⇒ no network, code logged to console. Accepts `1/true/yes`. |
| `SMS_DEFAULT_REGION` | `KE` | ISO region for phone parsing (web input). |
| `BONGA_API_CLIENT_ID` | — | Bonga client id. Required to send/query. |
| `BONGA_API_KEY` | — | Bonga API key. Required to send/query. |
| `BONGA_API_SECRET` | — | Bonga API secret. Required to **send**. |
| `BONGA_SERVICE_ID` | `1` | Bonga sender/service id — **confirm yours** in the dashboard. |
| `BONGA_API_URL_SEND` | `http://167.172.14.50:4002/v1/send-sms` | ⚠ cleartext HTTP (see §7). Override with your HTTPS proxy. |
| `BONGA_API_URL_BALANCE` | `https://app.bongasms.co.ke/api/check-credits` | HTTPS. |
| `BONGA_API_URL_DELIVERY` | `https://app.bongasms.co.ke/api/fetch-delivery` | HTTPS. |
| `OTP_TTL_MINUTES` | `10` | Code lifetime. |
| `OTP_LENGTH` | `6` | Code digits (4–10, leading zeros preserved). |
| `OTP_MAX_ATTEMPTS` | `5` | Wrong entries before a fresh code is required. |
| `OTP_RESEND_BASE_SECONDS` | `60` | Resend backoff base (grows 60·n). |
| `OTP_MAX_RESENDS` | `5` | Hard cap on resends. |

Credentials live **only** in `.env` (gitignored), never in git.

---

## 7. Security — cleartext send transport ⚠

Bonga's **vendor-published send host is plain HTTP** (an `IP:port` with no TLS).
The API **secret, recipient number, and message body therefore transit
UNENCRYPTED**. `balance`/`delivery` are HTTPS; only `send` is affected.

There is no TLS send endpoint from the vendor, and refusing to send would break
the only working path, so the code does **not** silently downgrade — instead:

- `src/sms/index.js` logs a **one-time loud warning** the first time a send runs
  against a cleartext non-loopback `BONGA_API_URL_SEND` (`isCleartextUrl`).
- **Mitigation:** point `BONGA_API_URL_SEND` at an **HTTPS proxy you operate**
  that terminates TLS and forwards to the Bonga host. Loopback
  (`localhost`/`127.0.0.1`) is exempt from the warning (a local TLS-terminating
  proxy is the intended secure setup).

Treat the risk as **live** until a proxy is in place: anyone on-path can read the
OTP and the Bonga secret. This was flagged in commit `08122c0`.

---

## 8. Open "VERIFY live" items (confirm during manual send test)

Two Bonga wire-format details were coded to the documented shape but **not yet
confirmed against the live endpoint** — resolve them on your first real send:

1. **Send body encoding.** Currently `application/x-www-form-urlencoded`
   (`URLSearchParams`). If the endpoint demands strict multipart, switch to the
   Node-18 global `FormData` in `bonga.js#send`. (Flagged in `bonga.js`.)
2. **Exact MSISDN shape.** Currently E.164-minus-`+` (digits only). If Bonga
   rejects it, adjust `toMsisdn` in `sms-rules.js` (e.g. `2547…` vs `07…` vs
   `+254…`). (Flagged in `sms-rules.js`.)

Also confirm your **`BONGA_SERVICE_ID`** (default `1` is a placeholder).

If a send returns a `666`/format error, these three are the first suspects.

---

## 9. CLI

```sh
node src/index.js sms balance                 # check-credits (HTTPS)
node src/index.js sms delivery <unique_id>    # fetch-delivery for a sent message
node src/index.js sms send <+E164phone> <text...>   # send (defaults text to a test string)
```

`balance`/`delivery` work with just `CLIENT_ID`+`KEY`. `send` additionally needs
`SECRET` and (unless disabled) `SMS_ENABLED=1`.

---

## 10. Manual test checklist (operator)

Run in order; stop at the first failure.

1. **Bonga dashboard** (`app.bongasms.co.ke/clients/developer`): note
   `CLIENT_ID`, `KEY`, `SECRET`, your `SERVICE_ID`; confirm you have credits.
2. **`.env`:** set `BONGA_API_CLIENT_ID` / `BONGA_API_KEY` / `BONGA_API_SECRET` /
   `BONGA_SERVICE_ID`, then `SMS_ENABLED=1`. (Optionally point
   `BONGA_API_URL_SEND` at your HTTPS proxy — see §7.)
3. **Balance (HTTPS, no send cost):** `node src/index.js sms balance` →
   expect `{ ok:true, status:222, credits:<N> }`. Proves creds + connectivity.
4. **Send (spends 1 credit):** `node src/index.js sms send +2547XXXXXXXX "Odds Pro test"`
   → expect `{ ok:true, messageId:<id> }` **and the phone receives the SMS**.
   *This is where §8's urlencoded-vs-multipart and MSISDN-shape questions get
   settled.* A cleartext warning printing here is expected (§7).
5. **Delivery:** `node src/index.js sms delivery <messageId>` → delivery status.
6. **End-to-end:** with `npm run serve` running, exercise signup → phone verify
   and confirm the real OTP SMS arrives and verifies.

Roll back by setting `SMS_ENABLED=0` (returns to console-log dev mode).
