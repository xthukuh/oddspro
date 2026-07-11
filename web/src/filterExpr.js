// Advanced client-side filter engine: recursive AND/OR groups, safe regex ops
// (match/not-match), and a sandboxed `$row[...]` expression language — all over
// the SAME derived semantics the table sorts/filters by (sortValue for numeric
// comparisons, rawValue for the displayed text). Pure module (imports only the
// sort registry + the shared CSV parser) so node:test covers it offline.
//
// It layers ABOVE the per-condition logic: `evalCondition` is the single source
// of condition truth (filterValues.js delegates to it), `evalGroup` combines
// conditions through nested groups, and `filterRows` is the whole-table entry.
// A flat condition array is treated as an implicit top-level AND group, so the
// existing `[{key,op,value}]` wire format keeps working unchanged.

import { sortValue } from './sortValues.js';
import { parseFilterList } from '../../src/db/filter-csv.js';
import { tipHit } from '../../src/db/tip-rules.js';

// Raw (displayed) value for text ops: the underlying field text, so e.g.
// `home_form like WWW` matches the letters, not the derived points. The tip
// column's text is its market pick (server parity: like -> fp.tip_market).
export function rawValue(row, col) {
    if (col.key === 'tip') return row.tip_market ?? null;
    if (col.group === 'market') return row.markets?.[col.key] ?? null;
    if (col.key.startsWith('fs:')) return row.stats?.[col.key] ?? null;
    return row[col.key] ?? null;
}

// R26b — tip-column filter value prefix. On the `tip` field a filter value may
// carry a `[H|M]?\d?:` prefix that redirects the match to a runner-up candidate
// and/or gates on the settled outcome. Split it off before the op runs:
//   `2:1X`  -> 2nd candidate, market compared against "1X"
//   `H:O 2` -> chosen candidate that HIT, market compared against "O 2"
//   `M2:`   -> 2nd candidate that MISSED (empty value = any market)
// A leading colon is required, so plain markets (`O 2.5`, `1X`, CSV lists) with
// no colon parse as { index:1, outcome:null } and behave exactly as before.
const TIP_PREFIX = /^([HM]?)(\d?):(.*)$/i;
export function parseTipFilter(value) {
    const s = value == null ? '' : String(value);
    const m = TIP_PREFIX.exec(s);
    if (!m) return { index: 1, outcome: null, value: s };
    const flag = m[1].toUpperCase();
    return {
        index: m[2] ? Number(m[2]) : 1,
        outcome: flag === 'H' ? 'hit' : flag === 'M' ? 'miss' : null,
        value: m[3],
    };
}

// Resolve the Nth tip candidate's market: 1 = the chosen tip (fp.tip_market),
// 2/3 = the runners-up persisted in tip_breakdown. null when the fixture has no
// tip or no candidate at that rank.
export function tipCandidateMarket(row, index) {
    if (index === 1) return row?.tip_market ?? null;
    const up = row?.tip_breakdown?.runners_up;
    return Array.isArray(up) ? (up[index - 2]?.market ?? null) : null;
}

// Grade the Nth candidate hit/miss from the fixture's final score (via tipHit,
// exactly as the tip cell settles runners-up). null when pending (no final
// score), the candidate is absent, or the market is unknown.
export function tipCandidateOutcome(row, index) {
    const market = tipCandidateMarket(row, index);
    if (market == null || !row?.score) return null;
    const [hs, as] = String(row.score).split('-').map(Number);
    if (!Number.isFinite(hs) || !Number.isFinite(as)) return null;
    try {
        return tipHit(market, hs, as) ? 'hit' : 'miss';
    } catch {
        return null;
    }
}

// Three-way comparison (-1/0/1), null when either side is missing/unparsable:
// missing data never satisfies a predicate (nulls-last spirit). Numbers compare
// numerically, everything else case-insensitively.
function compareValues(a, b) {
    if (a == null || b == null || b === '') return null;
    if (typeof a === 'number') {
        let n = typeof b === 'number' ? b : Number(b);
        // A non-numeric string RHS against a timestamp LHS (date columns sort as
        // Date.parse ms) parses as a date, so `start_time gte 2026-07-11` works
        // when a group evaluates it client-side.
        if (Number.isNaN(n) && typeof b === 'string') {
            const t = Date.parse(b);
            if (!Number.isNaN(t)) n = t;
        }
        return Number.isNaN(n) ? null : Math.sign(a - n);
    }
    return Math.sign(String(a).toLowerCase().localeCompare(String(b).toLowerCase()));
}

// Predicates over a three-way comparison result.
const CMP_OPS = {
    eq: c => c === 0,
    ne: c => c !== 0,
    gt: c => c > 0,
    gte: c => c >= 0,
    lt: c => c < 0,
    lte: c => c <= 0,
};

// Compile a user regex safely: cap the pattern length (ReDoS foot-gun guard)
// and swallow syntax errors — a bad pattern is a non-match, never a throw.
const REGEX_MAX = 200;
function safeRegex(pattern) {
    const s = pattern == null ? '' : String(pattern);
    if (!s || s.length > REGEX_MAX) return null;
    try {
        return new RegExp(s, 'i');
    } catch {
        return null;
    }
}

// Value-matching ops (value-only, no column-to-column form): text substring,
// CSV set membership, and safe regex. Shared by the general path and the tip
// candidate-prefix path so both grade identically. `raw` is passed un-coerced
// (numeric `in` normalization depends on its type); a null `raw` never matches.
const VALUE_OPS = new Set(['like', 'not-contains', 'in', 'not-in', 'match', 'not-match']);
function matchValueOp(op, raw, value) {
    if (raw == null) return false;
    if (op === 'like' || op === 'not-contains') {
        const has = String(raw).toLowerCase().includes(String(value).toLowerCase());
        return op === 'like' ? has : !has;
    }
    if (op === 'in' || op === 'not-in') {
        const inSet = parseFilterList(value).some(it => compareValues(raw, it) === 0);
        return op === 'in' ? inSet : !inSet;
    }
    // match / not-match
    const re = safeRegex(value);
    if (!re) return false;
    const m = re.test(String(raw));
    return op === 'match' ? m : !m;
}

// Resolve a column key to its descriptor. Accepts an array of descriptors (built
// once into a Map) or an already-built resolver function (the hot path in
// filterRows builds the resolver once, not per row).
function resolver(columns) {
    if (typeof columns === 'function') return columns;
    const byKey = new Map((columns ?? []).map(c => [c.key, c]));
    return k => byKey.get(k) ?? { key: k };
}

// Evaluate ONE condition to a boolean. Mirrors the flat-AND semantics exactly
// (text/set ops match rawValue, comparisons use sortValue, col-mode compares two
// derived values) and adds match/not-match regex ops + expr-type conditions.
function evalCond(row, cond, resolve) {
    if (!cond) return false;
    if (cond.type === 'expr') {
        try {
            return truthy(evalNode(parseExpr(cond.expr), row, resolve));
        } catch {
            return false; // malformed expression is a non-match, never a throw
        }
    }
    const lhs = resolve(cond.key);
    const op = cond.op;
    // Value-matching ops (text/set/regex, value-only). On the tip field the
    // value may carry an R26b `[H|M]?\d?:` prefix that redirects to a runner-up
    // candidate and/or gates on the settled outcome (AND-combined with the
    // market predicate); every other field matches its rawValue as before.
    if (VALUE_OPS.has(op) && cond.col == null) {
        if (lhs.key === 'tip') {
            const { index, outcome, value } = parseTipFilter(cond.value);
            if (outcome && tipCandidateOutcome(row, index) !== outcome) return false;
            return matchValueOp(op, tipCandidateMarket(row, index), value);
        }
        return matchValueOp(op, rawValue(row, lhs), cond.value);
    }
    const test = CMP_OPS[op];
    if (!test) return false;
    const rhs = cond.col != null ? sortValue(row, resolve(cond.col)) : cond.value;
    const cmp = compareValues(sortValue(row, lhs), rhs);
    return cmp != null && test(cmp);
}

// One item of a group: a nested group or a leaf condition.
function evalItem(row, item, resolve) {
    if (item && item.type === 'group') return evalGroupResolved(row, item, resolve);
    return evalCond(row, item, resolve);
}

// A group is an AND/OR over its items. An empty group is a neutral pass (no
// constraint) either way, so a half-built group never blanks the table.
function evalGroupResolved(row, group, resolve) {
    const items = group?.items;
    if (!Array.isArray(items) || !items.length) return true;
    return group.join === 'or'
        ? items.some(it => evalItem(row, it, resolve))
        : items.every(it => evalItem(row, it, resolve));
}

// A flat condition array = implicit top-level AND group (backward compatible).
function normalizeModel(model) {
    if (Array.isArray(model)) return { type: 'group', join: 'and', items: model };
    return model ?? { type: 'group', join: 'and', items: [] };
}

function isEmptyModel(model) {
    if (Array.isArray(model)) return model.length === 0;
    return !model || !Array.isArray(model.items) || model.items.length === 0;
}

// --- public surface -----------------------------------------------------

export function evalCondition(row, cond, columns) {
    return evalCond(row, cond, resolver(columns));
}

export function evalGroup(row, group, columns) {
    return evalGroupResolved(row, normalizeModel(group), resolver(columns));
}

// Filter rows through a model (group or flat array). An empty model returns the
// input array unchanged (same reference) — a no-op like applyClientFilters.
export function filterRows(rows, model, columns) {
    if (!Array.isArray(rows) || isEmptyModel(model)) return rows;
    const resolve = resolver(columns);
    const group = normalizeModel(model);
    return rows.filter(row => evalGroupResolved(row, group, resolve));
}

// ========================================================================
// Expression language — a hand-written recursive-descent parser/evaluator.
// NO eval / Function: the only escape hatches are the whitelisted HELPERS and
// $row[...] reads. Grammar (lowest→highest precedence):
//   or   := and (('||'|'or') and)*
//   and  := not (('&&'|'and') not)*
//   not  := ('!'|'not') not | cmp
//   cmp  := add (('=='|'='|'!='|'<>'|'>'|'>='|'<'|'<=') add)?
//   add  := mul (('+'|'-') mul)*
//   mul  := unary (('*'|'/'|'%') unary)*
//   unary:= '-' unary | primary
//   primary := number | string | true|false|null | $row['key'] | name(args) | '(' or ')'
// ========================================================================

const EXPR_MAX = 2000;   // cap raw expression length
const DEPTH_MAX = 64;    // cap parse nesting depth (stack-safety)

// Whitelisted helper functions (name is matched case-insensitively). Each gets
// the evaluated args plus (row, resolve) for the display-aware ones.
const HELPERS = {
    contains: (args) => {
        const [a, b] = args;
        if (a == null || b == null) return false;
        return String(a).toLowerCase().includes(String(b).toLowerCase());
    },
    in: (args) => {
        const [a, list] = args;
        if (a == null) return false;
        return parseFilterList(list == null ? '' : String(list)).some(it => compareValues(a, it) === 0);
    },
    raw: (args, row, resolve) => (args[0] == null ? null : rawValue(row, resolve(String(args[0])))),
    lower: (args) => (args[0] == null ? null : String(args[0]).toLowerCase()),
    upper: (args) => (args[0] == null ? null : String(args[0]).toUpperCase()),
    abs: (args) => { const n = Number(args[0]); return Number.isNaN(n) ? null : Math.abs(n); },
    num: (args) => { const n = Number(args[0]); return Number.isNaN(n) ? null : n; },
};

function tokenize(src) {
    if (src.length > EXPR_MAX) throw new Error('expression too long');
    const toks = [];
    let i = 0;
    const n = src.length;
    while (i < n) {
        const c = src[i];
        if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
        if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
            let j = i + 1;
            while (j < n && /[0-9.]/.test(src[j])) j++;
            const num = Number(src.slice(i, j));
            if (Number.isNaN(num)) throw new Error(`invalid number: ${src.slice(i, j)}`);
            toks.push({ type: 'num', value: num });
            i = j;
            continue;
        }
        if (c === '"' || c === "'") {
            const quote = c;
            let j = i + 1;
            let str = '';
            while (j < n && src[j] !== quote) {
                if (src[j] === '\\' && j + 1 < n) { str += src[j + 1]; j += 2; continue; }
                str += src[j++];
            }
            if (j >= n) throw new Error('unterminated string');
            toks.push({ type: 'str', value: str });
            i = j + 1;
            continue;
        }
        if (c === '$') {
            if (src.slice(i, i + 4) === '$row') { toks.push({ type: 'row' }); i += 4; continue; }
            throw new Error(`unexpected token: ${src.slice(i, i + 4)}`);
        }
        if (/[A-Za-z_]/.test(c)) {
            let j = i + 1;
            while (j < n && /[A-Za-z0-9_]/.test(src[j])) j++;
            toks.push({ type: 'ident', value: src.slice(i, j) });
            i = j;
            continue;
        }
        const two = src.slice(i, i + 2);
        if (['&&', '||', '==', '!=', '<>', '>=', '<='].includes(two)) { toks.push({ type: 'op', value: two }); i += 2; continue; }
        if ('+-*/%()[],!<>='.includes(c)) { toks.push({ type: 'op', value: c }); i++; continue; }
        if (c === '.') throw new Error('unexpected member access "."');
        throw new Error(`unexpected character: ${c}`);
    }
    toks.push({ type: 'eof' });
    return toks;
}

function parse(tokens) {
    let pos = 0;
    let depth = 0;
    const peek = () => tokens[pos];
    const isOp = v => peek().type === 'op' && peek().value === v;
    const isKw = kw => peek().type === 'ident' && peek().value.toLowerCase() === kw;
    const eatOp = (v) => { if (!isOp(v)) throw new Error(`expected '${v}'`); pos++; };

    const parseOr = () => {
        let left = parseAnd();
        while (isOp('||') || isKw('or')) { pos++; left = { type: 'logic', op: 'or', left, right: parseAnd() }; }
        return left;
    };
    const parseAnd = () => {
        let left = parseNot();
        while (isOp('&&') || isKw('and')) { pos++; left = { type: 'logic', op: 'and', left, right: parseNot() }; }
        return left;
    };
    const parseNot = () => {
        if (isOp('!') || isKw('not')) { pos++; return { type: 'not', arg: parseNot() }; }
        return parseCmp();
    };
    const parseCmp = () => {
        const left = parseAdd();
        const t = peek();
        if (t.type === 'op' && ['==', '=', '!=', '<>', '>', '>=', '<', '<='].includes(t.value)) {
            pos++;
            return { type: 'cmp', op: t.value, left, right: parseAdd() };
        }
        return left;
    };
    const parseAdd = () => {
        let left = parseMul();
        while (peek().type === 'op' && (peek().value === '+' || peek().value === '-')) {
            const op = tokens[pos++].value;
            left = { type: 'arith', op, left, right: parseMul() };
        }
        return left;
    };
    const parseMul = () => {
        let left = parseUnary();
        while (peek().type === 'op' && (peek().value === '*' || peek().value === '/' || peek().value === '%')) {
            const op = tokens[pos++].value;
            left = { type: 'arith', op, left, right: parseUnary() };
        }
        return left;
    };
    const parseUnary = () => {
        if (isOp('-')) { pos++; return { type: 'neg', arg: parseUnary() }; }
        return parsePrimary();
    };
    const parsePrimary = () => {
        if (++depth > DEPTH_MAX) throw new Error('expression nested too deep');
        try {
            const t = peek();
            if (t.type === 'num' || t.type === 'str') { pos++; return { type: 'lit', value: t.value }; }
            if (t.type === 'row') {
                pos++;
                eatOp('[');
                const key = peek();
                if (key.type !== 'str') throw new Error("expected a string key in $row[...]");
                pos++;
                eatOp(']');
                return { type: 'row', key: key.value };
            }
            if (isOp('(')) { pos++; const e = parseOr(); eatOp(')'); return e; }
            if (t.type === 'ident') {
                pos++;
                const lw = t.value.toLowerCase();
                if (lw === 'true') return { type: 'lit', value: true };
                if (lw === 'false') return { type: 'lit', value: false };
                if (lw === 'null') return { type: 'lit', value: null };
                if (isOp('(')) {
                    pos++;
                    const args = [];
                    if (!isOp(')')) {
                        args.push(parseOr());
                        while (isOp(',')) { pos++; args.push(parseOr()); }
                    }
                    eatOp(')');
                    if (!HELPERS[lw]) throw new Error(`unknown function: ${t.value}`);
                    return { type: 'call', name: lw, args };
                }
                throw new Error(`unknown identifier: ${t.value}`);
            }
            throw new Error(t.type === 'eof' ? 'unexpected end of expression' : `unexpected token: ${JSON.stringify(t.value)}`);
        } finally {
            depth--;
        }
    };

    const node = parseOr();
    if (peek().type !== 'eof') throw new Error(`unexpected token: ${JSON.stringify(peek().value)}`);
    return node;
}

function truthy(v) {
    if (v == null) return false;
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return v !== 0;
    if (typeof v === 'string') return v !== '';
    return Boolean(v);
}

function evalNode(node, row, resolve) {
    switch (node.type) {
        case 'lit': return node.value;
        case 'row': return sortValue(row, resolve(node.key));
        case 'neg': { const v = evalNode(node.arg, row, resolve); return v == null ? null : -Number(v); }
        case 'not': return !truthy(evalNode(node.arg, row, resolve));
        case 'logic': {
            const l = truthy(evalNode(node.left, row, resolve));
            if (node.op === 'and') return l && truthy(evalNode(node.right, row, resolve));
            return l || truthy(evalNode(node.right, row, resolve));
        }
        case 'arith': {
            const a = evalNode(node.left, row, resolve);
            const b = evalNode(node.right, row, resolve);
            if (a == null || b == null) return null;
            const x = Number(a);
            const y = Number(b);
            if (Number.isNaN(x) || Number.isNaN(y)) return null;
            switch (node.op) {
                case '+': return x + y;
                case '-': return x - y;
                case '*': return x * y;
                case '/': return y === 0 ? null : x / y;
                case '%': return y === 0 ? null : x % y;
                default: return null;
            }
        }
        case 'cmp': {
            const c = compareValues(evalNode(node.left, row, resolve), evalNode(node.right, row, resolve));
            if (c == null) return false;
            switch (node.op) {
                case '==': case '=': return c === 0;
                case '!=': case '<>': return c !== 0;
                case '>': return c > 0;
                case '>=': return c >= 0;
                case '<': return c < 0;
                case '<=': return c <= 0;
                default: return false;
            }
        }
        case 'call': return HELPERS[node.name](node.args.map(a => evalNode(a, row, resolve)), row, resolve);
        default: return null;
    }
}

// Parse an expression string into an AST, memoized (parse errors cached too so
// a bad expression in the live-preview loop doesn't re-parse every keystroke).
// Throws a descriptive Error on syntax errors — the UI surfaces it live.
const _parseCache = new Map();
export function parseExpr(expr) {
    const key = String(expr);
    if (_parseCache.has(key)) {
        const c = _parseCache.get(key);
        if (c.error) throw c.error;
        return c.ast;
    }
    let entry;
    try {
        entry = { ast: parse(tokenize(key)) };
    } catch (e) {
        entry = { error: e };
    }
    if (_parseCache.size > 200) _parseCache.clear();
    _parseCache.set(key, entry);
    if (entry.error) throw entry.error;
    return entry.ast;
}

// Evaluate an expression against a row, returning its value (number/boolean/
// string/null). Throws on a syntax error (callers that want a non-match on bad
// input — evalCond — wrap it in try/catch).
export function evalExpr(row, expr, columns) {
    return evalNode(parseExpr(expr), row, resolver(columns));
}
