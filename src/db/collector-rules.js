// Pure classification of a bookmaker list-page response. Zero imports, so the
// tests run offline with no network, config or DB.
//
// Background: the 2026-08-19 durability fix made a failed BetPawa list page
// throw instead of being swallowed into an empty page, because `done = len <
// take` then read TRUE and a TRUNCATED buffer was persisted as a complete day
// (view-once bookmaker odds, lost for good). That fix was right, but it treated
// "no results" and "broken response" as the same thing.
//
// They are not. Probed against the live API 2026-08-19:
//
//   page with results  -> {"responses":[{"responses":[ ...events ]}]}
//   page past the end  -> {"responses":[{}]}          <- HTTP 200, valid JSON
//
// BetPawa signals an empty result set by OMITTING the inner key rather than
// returning []. So a day with nothing upcoming left (every night, once the last
// kickoff passes) and a day whose event count is an exact multiple of the page
// size both looked "malformed", and the light pass reported a failed odds step
// every 15 minutes. A false alarm on the irreplaceable-odds path is worse than
// noise: it is what teaches an operator to ignore the real one.
//
// The distinction that matters is the ENVELOPE. A transient fault does not
// produce a well-formed envelope: a timeout or reset never returns, a 4xx/5xx
// is caught by status, and a truncated body fails JSON parsing before it gets
// here. An object whose `responses[0]` is a plain object with no inner key is
// the API answering "nothing here", and it is safe to read as zero items -
// worst case we skip one refresh cycle and the next pass retries, rather than
// persisting a partial day as a complete one.

// Classify one list-page body.
//
//   { status: 'ok',        items: [...] }  usable page, may legitimately be []
//   { status: 'empty',     items: [] }     the API's explicit "no results"
//   { status: 'malformed', items: [] }     unusable - caller must retry/throw
//
// Total: any input shape at all, including null/undefined/strings/arrays.
export function listPageOutcome(body) {
    const envelope = body?.responses;
    // The envelope itself must be a well-formed array of query results. Anything
    // else is a body we do not understand, and guessing is how the original bug
    // happened.
    if (!Array.isArray(envelope) || envelope.length === 0) return { status: 'malformed', items: [] };
    const first = envelope[0];
    if (first === null || typeof first !== 'object' || Array.isArray(first)) {
        return { status: 'malformed', items: [] };
    }
    const items = first.responses;
    if (Array.isArray(items)) return { status: 'ok', items };
    // Well-formed envelope, inner key absent: the API's "no results" shape.
    // Only an EMPTY object qualifies. A first entry carrying other keys but no
    // `responses` is a shape we have never seen, so it stays malformed.
    if (Object.keys(first).length === 0) return { status: 'empty', items: [] };
    return { status: 'malformed', items: [] };
}

// Does this page end the pagination? A page the API reported as empty always
// ends it; otherwise the usual short-page test applies. Kept here so the pager
// never re-derives `done` from a page it could not actually read.
export function listPageDone(outcome, take) {
    if (outcome.status === 'empty') return true;
    return outcome.items.length < take;
}

// Betika's list pages are a different envelope: `{ data: [ ...matches ], meta }`.
// Probed live 2026-08-19: a page past the end answers HTTP 200 with `data: []`,
// a REAL empty array, so unlike BetPawa there is no empty-vs-omitted ambiguity
// to resolve.
//
// The hazard is the other one. `fetchBetikaGames` used to read its page as
// `Array.isArray(data.data) ? data.data : []`, so a degraded 200 whose body
// carries no `data` array (an error envelope, a truncated proxy response)
// collapsed to an empty page - and since the loop terminates on
// `len < limit`, a failure on page 3 of 10 returned the first two pages AS IF
// they were the complete day. That is exactly the silent truncation that cost
// three days of irreplaceable BetPawa odds on 2026-08-16, sitting unfixed in
// the other provider.
//
// So: a well-formed page (the key IS an array) is usable even when empty;
// anything else is malformed and must be retried, then thrown.
export function dataPageOutcome(body, key = 'data') {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        return { status: 'malformed', items: [] };
    }
    const items = body[key];
    if (Array.isArray(items)) return { status: 'ok', items };
    return { status: 'malformed', items: [] };
}
