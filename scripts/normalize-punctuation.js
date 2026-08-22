// ASCII punctuation normalization, repo-wide.
//
// The owner's standing rule: no em-dash (U+2014), en-dash (U+2013), curly
// quotes (U+2018/U+2019/U+201C/U+201D) or ellipsis (U+2026) in any prose.
// This script walks every git-tracked file and rewrites those characters to
// their ASCII equivalents:
//   - em-dash between words -> ' - ' (spaces collapsed to exactly one each side)
//   - en-dash               -> '-'   (numeric ranges like '1-5', '08:00-09:00')
//   - curly single quotes   -> '\'' (escaped to \' if it would otherwise close
//                              its own enclosing single-quoted JS string)
//   - curly double quotes   -> '"'  (escaped to \" the same way for a "-string)
//   - ellipsis              -> '...'
//
// Usage:
//   node scripts/normalize-punctuation.js           rewrite files in place
//   node scripts/normalize-punctuation.js --check    report only, exit 1 if any offenders
//
// Idempotent: running it twice makes no further changes (the replacements
// never reintroduce a target character).
//
// EXCEPTIONS (deliberately left untouched):
//   - Files matched by SKIP_PATH_PREFIXES / SKIP_BASENAMES / SKIP_EXTENSIONS
//     below (binaries, build output, dependencies, lockfiles, fonts, images,
//     SQL dumps, and the root x-*-output*.json fetched-data snapshots).
//   - Any file that sniffs as binary (a NUL byte in its first 8000 bytes).
//   - PROTECTED_LINE_MARKERS: specific lines in src/tests/web that build a
//     regex or character-class testing FOR one of these characters (the
//     character there is the thing being matched, not prose - rewriting it
//     would silently change what the regex matches). Found by manual audit
//     2026-08-23; extend this list if a future regex/char-class literal needs
//     the same protection. Plain display-string literals that merely CONTAIN
//     one of these characters (UI placeholders, "no data" dashes, etc.) are
//     NOT protected - they get normalized like any other text, and since the
//     transform is deterministic, any test asserting their exact output gets
//     the identical transform applied to its own expected-string literal, so
//     the two stay in sync automatically.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const CHECK_ONLY = process.argv.includes('--check');

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();

// -- File-level exceptions --------------------------------------------------

const SKIP_PATH_PREFIXES = [
    'web/dist/',
    'node_modules/',
];

const SKIP_BASENAMES = new Set([
    'normalize-punctuation.js',   // this script: its own regex literals ARE the target characters
    'package-lock.json',
    'npm-shrinkwrap.json',
    'yarn.lock',
    'pnpm-lock.yaml',
]);

const SKIP_EXTENSIONS = new Set([
    // fonts
    '.ttf', '.otf', '.woff', '.woff2', '.eot',
    // images
    '.png', '.jpg', '.jpeg', '.gif', '.ico', '.bmp', '.webp', '.svg',
]);

// x-*-output*.json fetched-data snapshots at the repo root (CLAUDE.md: "do
// not delete", and their bookmaker-provided prose is not ours to rewrite).
const ROOT_SNAPSHOT_RE = /^x-.*-output.*\.json$/;

// *.sql / *.sql.gz / *.sql.zip etc - dumps, never hand-edited.
const SQL_RE = /\.sql(\.|$)/i;

function isSkippedPath(relPath) {
    const posixPath = relPath.split(path.sep).join('/');
    if (SKIP_PATH_PREFIXES.some(p => posixPath.startsWith(p))) return 'path prefix';
    const base = path.basename(posixPath);
    if (SKIP_BASENAMES.has(base)) return 'lockfile';
    const ext = path.extname(base).toLowerCase();
    if (SKIP_EXTENSIONS.has(ext)) return 'font/image';
    if (SQL_RE.test(base)) return 'sql dump';
    if (!posixPath.includes('/') && ROOT_SNAPSHOT_RE.test(base)) return 'root data snapshot';
    return null;
}

const CODE_EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx']);

// -- Line-level exceptions ---------------------------------------------------
// Exact substrings; a line containing one of these is left completely
// unchanged. See the file-header comment for why.
const PROTECTED_LINE_MARKERS = [
    '!/[–—]/.test(s)',                 // tests/glossary.test.js - asserts glossary text has no en/em dash
    'assert.doesNotMatch(combo.label, /—/)', // tests/markets.test.js - asserts no em-dash in a generated market label
    'assert.doesNotMatch(raw.label, /—/)',   // tests/markets.test.js - same, for the raw passthrough label
];

function isProtectedLine(ext, line) {
    if (!CODE_EXTENSIONS.has(ext)) return false;
    return PROTECTED_LINE_MARKERS.some(marker => line.includes(marker));
}

// -- The character transforms ------------------------------------------------

const EM_DASH_RE = /[ \t]*—[ \t]*/g;

// A curly apostrophe/quote that sits INSIDE a same-delimiter JS string
// literal was syntactically harmless before normalization ('it’s fine'
// parses as one string), but a bare straight-quote replacement would close
// the string early and corrupt the file ('it's fine' does not). For code
// files we track single/double/backtick-string state per line (naive but
// sufficient: no multi-line template literals contain these characters in
// this repo, verified by the post-run build/test check) and EMIT AN ESCAPED
// QUOTE (\' or \") when the replacement would land inside its own delimiter.
// Outside of a same-delimiter string (plain code, JSX text, comments, or
// inside a *different* delimiter) a bare quote is safe and used as-is.
function quoteStatesBefore(line) {
    const states = new Array(line.length);
    let mode = null; // null | "'" | '"' | '`'
    let escaped = false;
    for (let i = 0; i < line.length; i++) {
        states[i] = mode;
        const c = line[i];
        if (escaped) { escaped = false; continue; }
        if (c === '\\') { escaped = true; continue; }
        if (mode === null) {
            if (c === '\'' || c === '"' || c === '`') mode = c;
        } else if (c === mode) {
            mode = null;
        }
    }
    return states;
}

function normalizeLine(line, isCode) {
    const quoteState = isCode ? quoteStatesBefore(line) : null;
    let out = '';
    let n = 0;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === '‘' || c === '’') {
            n++;
            out += (quoteState && quoteState[i] === '\'') ? '\\\'' : '\'';
        } else if (c === '“' || c === '”') {
            n++;
            out += (quoteState && quoteState[i] === '"') ? '\\"' : '"';
        } else if (c === '…') {
            n++;
            out += '...';
        } else if (c === '–') {
            n++;
            out += '-';
        } else {
            out += c;
        }
    }
    // Em-dash: collapse surrounding horizontal whitespace to a single space
    // on each side (counted separately since it is whitespace-swallowing,
    // unlike the single-character swaps above).
    out = out.replace(EM_DASH_RE, () => { n++; return ' - '; });
    return { out, n };
}

// -- Binary sniff -------------------------------------------------------------

function looksBinary(buf) {
    return buf.subarray(0, 8000).includes(0);
}

// -- Main ---------------------------------------------------------------------

function main() {
    const files = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8', maxBuffer: 1024 * 1024 * 64 })
        .split('\n')
        .filter(Boolean);

    const skipped = new Map(); // reason -> count
    const skippedLines = [];   // { file, line, content }
    const perFileCounts = [];  // { file, counts: {em,en,squote,dquote,ellipsis} }
    let totalReplacements = 0;
    let offenderCount = 0; // for --check

    for (const relPath of files) {
        const skipReason = isSkippedPath(relPath);
        if (skipReason) {
            skipped.set(skipReason, (skipped.get(skipReason) || 0) + 1);
            continue;
        }

        const full = path.join(root, relPath);
        let buf;
        try {
            buf = fs.readFileSync(full);
        } catch {
            skipped.set('unreadable', (skipped.get('unreadable') || 0) + 1);
            continue;
        }

        if (looksBinary(buf)) {
            skipped.set('binary', (skipped.get('binary') || 0) + 1);
            continue;
        }

        // BOM detection/preservation.
        let hasBom = false;
        let body = buf;
        if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
            hasBom = true;
            body = buf.subarray(3);
        }

        let text;
        try {
            text = body.toString('utf8');
        } catch {
            skipped.set('bad-utf8', (skipped.get('bad-utf8') || 0) + 1);
            continue;
        }

        // Skip files with no target characters at all - avoids touching
        // line-ending/BOM bytes on files we have nothing to change in.
        if (!/[—–‘’“”…]/.test(text)) continue;

        const ext = path.extname(relPath).toLowerCase();

        // Split keeping line terminators as separate array elements so the
        // original CRLF/LF/mixed line endings are preserved verbatim.
        const parts = text.split(/(\r\n|\r|\n)/);

        let fileTotal = 0;
        let fileEm = 0, fileEn = 0, fileSq = 0, fileDq = 0, fileEl = 0;
        let fileOffenders = 0;

        for (let i = 0; i < parts.length; i += 2) {
            const line = parts[i];
            if (!/[—–‘’“”…]/.test(line)) continue;

            if (isProtectedLine(ext, line)) {
                skippedLines.push({ file: relPath, line: (i / 2) + 1, content: line.trim() });
                continue;
            }

            // Count per class before replacing (for --check reporting too).
            fileEm += (line.match(/—/g) || []).length;
            fileEn += (line.match(/–/g) || []).length;
            fileSq += (line.match(/[‘’]/g) || []).length;
            fileDq += (line.match(/[“”]/g) || []).length;
            fileEl += (line.match(/…/g) || []).length;
            fileOffenders++;

            const { out, n } = normalizeLine(line, CODE_EXTENSIONS.has(ext));
            parts[i] = out;
            fileTotal += n;
        }

        if (fileOffenders > 0) offenderCount += fileOffenders;
        if (fileTotal === 0) continue;

        totalReplacements += fileTotal;
        perFileCounts.push({
            file: relPath,
            total: fileTotal,
            em: fileEm, en: fileEn, squote: fileSq, dquote: fileDq, ellipsis: fileEl,
        });

        if (!CHECK_ONLY) {
            const newText = parts.join('');
            const outBuf = hasBom
                ? Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(newText, 'utf8')])
                : Buffer.from(newText, 'utf8');
            fs.writeFileSync(full, outBuf);
        }
    }

    // -- Report ---------------------------------------------------------------

    if (CHECK_ONLY) {
        if (perFileCounts.length === 0) {
            console.log('normalize-punctuation --check: clean, no offending characters found.');
        } else {
            console.log('normalize-punctuation --check: offending characters found:\n');
            for (const f of perFileCounts) {
                console.log(`  ${f.file}: ${f.total} (em=${f.em} en=${f.en} 'quote=${f.squote} "quote=${f.dquote} ellipsis=${f.ellipsis})`);
            }
        }
    } else {
        console.log(`normalize-punctuation: ${perFileCounts.length} file(s) changed, ${totalReplacements} replacement(s).`);
        for (const f of perFileCounts) {
            console.log(`  ${f.file}: ${f.total} (em=${f.em} en=${f.en} 'quote=${f.squote} "quote=${f.dquote} ellipsis=${f.ellipsis})`);
        }
    }

    if (skippedLines.length > 0) {
        console.log(`\nProtected lines left untouched (regex/char-class literals - see PROTECTED_LINE_MARKERS):`);
        for (const s of skippedLines) console.log(`  ${s.file}:${s.line}: ${s.content}`);
    }

    if (skipped.size > 0) {
        console.log('\nFiles skipped by category:');
        for (const [reason, count] of skipped) console.log(`  ${reason}: ${count}`);
    }

    if (CHECK_ONLY && perFileCounts.length > 0) {
        process.exit(1);
    }
}

main();
