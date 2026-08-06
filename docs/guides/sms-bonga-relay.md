# Bonga SMS AppScript relay (`bonga-sms-relay`)

**Why it exists (2026-08-07):** Bonga's cleartext send host
(`http://167.172.14.50:4002/v1/send-sms`) blocks/blacklists requests from the
shared-hosting production server (sends work from the local box, fail from the
remote). A Google Apps Script web app relays the send POST from Google's
infrastructure instead, and as a bonus terminates TLS - the API secret no
longer transits cleartext from our side, so the boot cleartext-send warning
disappears.

**Wiring:** config-only. `BONGA_API_URL_SEND` points at the web-app exec URL:

```
BONGA_API_URL_SEND=https://script.google.com/macros/s/AKfycby-J_Hv3puSeLaJTbX4LjPMD_L37pgARS0gr4hbBC0k9K6liw2w2TxXS-rfIUJIbosZxg/exec
```

No code change: the relay forwards the urlencoded form unchanged and returns
JSON that spreads Bonga's parsed body LAST (`{_version, success, row, status,
...bongaBody}`), so `status: 222` / `unique_id` / `credits` sit exactly where
`parseBongaSend` (src/db/sms-rules.js) expects them and zod ignores the
wrapper keys. Balance and delivery stay DIRECT to Bonga's HTTPS app host -
only the send host is blacklisted. Non-JSON upstream bodies come back as
`{_invalid_JSON: body}` which folds to the tolerant `{ok:false}` verdict.

**Latency:** an AppScript round-trip adds ~3-8 s (cold starts more). The send
timeout is 20 s and M13 caps the user-facing response wait at 8 s with late
verdicts logged server-side, so the UX contract holds.

**Authorization requirement (the one deployment gotcha):** the web-app
deployment must be authorized for the `script.external_request` scope or every
send fails with `You do not have permission to call UrlFetchApp.fetch`
(observed live 2026-08-07). Fix: in the Apps Script editor run any function
that calls `UrlFetchApp.fetch` once (e.g. a throwaway `authProbe()`), approve
the consent dialog, then Deploy -> Manage deployments -> Edit -> New version.
If the project has an explicit `appsscript.json` `oauthScopes` list, it must
include `https://www.googleapis.com/auth/script.external_request`.

**Live re-test:** `node tmp/test-bonga-relay.js` (throwaway, gitignored) - or
any signup OTP. Expect `ok:true, status:222` plus a delivery report ~12 s
later.

**Logs:** every relayed request lands in the bound Google Sheet, `logs` sheet
(`Timestamp | Payload | Status | Response`). GET on the exec URL returns the
log as JSON. NB the payload column contains the API key/secret - keep the
spreadsheet private.

## Code.gs (deployed source, v1.0.5)

```javascript
/**
 * Google Apps Script HTTP Relay
 *
 * Prerequisites:
 * - Google Sheet with a "logs" sheet
 * - Apps Script bound to the spreadsheet
 * - Web App deployment enabled
 *
 * Deploy:
 *   Deploy -> New deployment -> Web app
 *   Execute as: Me
 *   Who has access: Anyone
 *
 * GET  -> doGet(e)
 * POST -> doPost(e)
 * No triggers required.
 *
 * Sheet:
 *   logs!A:D
 *   Timestamp | Payload | Status | Response
 *
 * POST example:
 * curl -L -X POST 'WEB_APP_URL' -H 'Content-Type: application/x-www-form-urlencoded' --data-urlencode 'apiClientID=1461' --data-urlencode 'key=xxxxx' --data-urlencode 'secret=xxxxx' --data-urlencode 'txtMessage=Hello World' --data-urlencode 'MSISDN=254799944004' --data-urlencode 'serviceID=1'
 *
 * GET example:
 * curl -L 'WEB_APP_URL'
 */

const CONFIG = {
  sheet: 'logs',
  version: '1.0.5',
  relay: {
    url: 'http://167.172.14.50:4002/v1/send-sms',
    method: 'POST',
    contentType: 'application/x-www-form-urlencoded'
  }
};


/**
 * POST relay endpoint.
 *
 * Receives request payload, logs it,
 * forwards unchanged, and returns JSON.
 */
function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.tryLock(10000);

  const sheet = getMainSheet();
  let row;

  try {
    const payload = e?.parameter;

    if (!payload || Object.keys(payload).length === 0) {
      throw new Error('Empty request payload');
    }

    row = sheet.getLastRow() + 1;
    sheet.appendRow([new Date(), JSON.stringify(payload), 'PENDING', '']);

    const response = UrlFetchApp.fetch(CONFIG.relay.url, {
      method: CONFIG.relay.method,
      payload,
      contentType: CONFIG.relay.contentType,
      muteHttpExceptions: true
    });

    const status = response.getResponseCode();
    const body = response.getContentText();

    sheet.getRange(row, 3, 1, 2).setValues([[status, body]]);

    return jsonResponse({
      success: true,
      row,
      status,
      ...parseResponse(body)
    });

  } catch (err) {
    row = sheet.getLastRow() + 1;
    sheet.appendRow([new Date(), '', 'ERROR', err.message]);

    return jsonResponse({
      success: false,
      row,
      error: err.message
    });

  } finally {
    lock.releaseLock();
  }
}


/**
 * GET endpoint.
 *
 * Returns relay logs.
 */
function doGet(e) {
  const lock = LockService.getScriptLock();
  lock.tryLock(10000);

  try {
    return jsonResponse({
      success: true,
      data: getSheetRecords()
    });

  } catch (err) {
    return jsonResponse({
      success: false,
      error: err.message
    });

  } finally {
    lock.releaseLock();
  }
}


/*
|-------------------------------------------------------------
| Helpers
|-------------------------------------------------------------
*/


function getMainSheet() {
  return SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.sheet);
}


function jsonResponse(data) {
  return ContentService
    .createTextOutput(JSON.stringify({_version: CONFIG.version, ...data}))
    .setMimeType(ContentService.MimeType.JSON);
}


function parseResponse(body) {
  try {
    return JSON.parse(body);
  } catch (err) {
    // Some APIs return plain text even when the request succeeds.
    return { '_invalid_JSON': body };
  }
}


function getSheetRecords() {
  const sheet = getMainSheet();
  const values = sheet.getDataRange().getValues();

  if (values.length < 2) {
    return [];
  }

  const headers = values[0];

  return values.slice(1).map(row => {
    const obj = {};

    headers.forEach((header, index) => {
      obj[header] = row[index];
    });

    return obj;
  });
}
```
