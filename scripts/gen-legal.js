// M4: generate the static legal pages (web/public/{privacy,terms}/index.html)
// from the ONE content source web/src/legal/legalContent.js - the same module
// LegalModal.jsx renders in-app, so the pages can never drift from the modal.
// Wired into `npm run build:web` (vite copies web/public/ into web/dist/, so
// prod Apache serves /privacy/ and /terms/ statically); the outputs are also
// committed so the pages exist without a build step.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRIVACY, TERMS, OPERATOR, TERMS_VERSION } from '../web/src/legal/legalContent.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const esc = s => String(s)
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');

// "- " paragraphs render as one <ul> per consecutive run (the legalContent
// body convention); everything else is a <p>.
function bodyHtml(body) {
    const out = [];
    let list = null;
    for (const para of body) {
        if (para.startsWith('- ')) {
            if (!list) { list = []; out.push(list); }
            list.push(`<li>${esc(para.slice(2))}</li>`);
        } else {
            list = null;
            out.push(`<p>${esc(para)}</p>`);
        }
    }
    return out.map(x => (Array.isArray(x) ? `<ul>\n${x.join('\n')}\n</ul>` : x)).join('\n');
}

function pageHtml(doc, other) {
    const sections = doc.sections.map(s => `<section id="${esc(s.id)}">\n<h2>${esc(s.title)}</h2>\n${bodyHtml(s.body)}\n</section>`).join('\n');
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${esc(doc.title)} - ${esc(OPERATOR.name)}</title>
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<style>
:root { color-scheme: light dark; }
body { margin: 0 auto; max-width: 44rem; padding: 2rem 1.25rem 4rem; font: 15px/1.6 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #1c1c1e; background: #fff; }
h1 { font-size: 1.5rem; margin: 0 0 0.25rem; }
h2 { font-size: 1.05rem; margin: 1.75rem 0 0.5rem; }
p, li { margin: 0.5rem 0; }
ul { padding-left: 1.25rem; }
a { color: #0FB5A6; text-decoration: none; }
a:hover { text-decoration: underline; }
.meta { color: #6e6e73; font-size: 0.85rem; margin-bottom: 1.5rem; }
@media (prefers-color-scheme: dark) {
    body { color: #f4f2f0; background: #1a191d; }
    .meta { color: #a09da5; }
    a { color: #17C9BA; }
}
</style>
</head>
<body>
<h1>${esc(doc.title)}</h1>
<p class="meta">${esc(OPERATOR.name)} (oddspro.ke) &middot; Version ${esc(TERMS_VERSION)} &middot; Last updated ${esc(doc.updated)} &middot; <a href="/">Back to Oddspro</a> &middot; <a href="/${esc(other.slug)}/">${esc(other.title)}</a></p>
${sections}
</body>
</html>
`;
}

for (const [doc, other] of [[PRIVACY, TERMS], [TERMS, PRIVACY]]) {
    const dir = path.join(ROOT, 'web', 'public', doc.slug);
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, 'index.html');
    await writeFile(file, pageHtml(doc, other), 'utf8');
    console.log(`[+] gen-legal: wrote ${path.relative(ROOT, file)} (${doc.sections.length} sections, v${TERMS_VERSION})`);
}
