// Pure CSV-list parser for the `in` / `not-in` filter operators (zero imports,
// offline-testable). Shared VERBATIM by the server (src/db/records.js) and the
// web client (web/src/filterValues.js) so both sides split a list identically -
// vite's server.fs.allow ['..'] serves the out-of-root import in dev and the
// build follows the relative import natively (same idiom as magic-rules.js).
//
// Single-line CSV: comma-separated; an item may be wrapped in double quotes to
// hold commas or spaces (e.g. `"Liga 1, B"`), and `""` inside quotes is a
// literal quote. Unquoted items are trimmed; empty items are dropped.
//   parseFilterList('"O 0.5",2.5') -> ['O 0.5', '2.5']
//   parseFilterList('a,"b,c",d')   -> ['a', 'b,c', 'd']
export function parseFilterList(value) {
    const s = value == null ? '' : String(value);
    const items = [];
    let i = 0;
    const n = s.length;
    while (i < n) {
        // Skip whitespace before an item so ` a , b ` -> ['a','b']
        while (i < n && (s[i] === ' ' || s[i] === '\t')) i++;
        if (i >= n) break;
        let item = '';
        if (s[i] === '"') {
            // Quoted item: consume until the closing quote; "" is a literal "
            i++;
            while (i < n) {
                if (s[i] === '"') {
                    if (s[i + 1] === '"') { item += '"'; i += 2; continue; }
                    i++; // closing quote
                    break;
                }
                item += s[i++];
            }
            // Ignore any stray chars/whitespace between the quote and the comma
            while (i < n && s[i] !== ',') i++;
        } else {
            while (i < n && s[i] !== ',') item += s[i++];
            item = item.trim();
        }
        if (item !== '') items.push(item);
        if (i < n && s[i] === ',') i++; // consume the separator
    }
    return items;
}
