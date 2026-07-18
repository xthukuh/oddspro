import { useState } from 'react';
import Sheet, { SheetClose } from './Sheet.jsx';
import CollapseSection from './CollapseSection.jsx';
import { PRIVACY, TERMS, TERMS_VERSION, OPERATOR } from '../legal/legalContent.js';

// M4: in-app legal viewer over the ONE content module scripts/gen-legal.js
// also renders into the static /privacy/ and /terms/ pages - modal and pages
// can never drift. `doc` picks the opening document; a header segmented
// toggle switches between the two without closing.

// "- " paragraphs render as one <ul> per consecutive run (the legalContent
// body convention, mirrored by gen-legal.js).
function Paras({ body }) {
    const blocks = [];
    let list = null;
    for (const para of body) {
        if (para.startsWith('- ')) {
            if (!list) { list = []; blocks.push({ list }); }
            list.push(para.slice(2));
        } else {
            list = null;
            blocks.push({ para });
        }
    }
    return blocks.map((b, i) => (b.list
        ? <ul key={i} className="list-disc pl-5 my-1.5 flex flex-col gap-1">{b.list.map((li, j) => <li key={j}>{li}</li>)}</ul>
        : <p key={i} className="my-1.5">{b.para}</p>
    ));
}

export default function LegalModal({ doc = 'terms', onClose }) {
    const [slug, setSlug] = useState(doc);
    const active = slug === 'privacy' ? PRIVACY : TERMS;
    const tabCls = on => `cursor-pointer px-3 h-8 rounded-full text-[13px] font-medium ${on ? 'bg-accent-soft text-accent' : 'text-label-2 hover:bg-fill'}`;
    return (
        <Sheet onClose={onClose} className="flex flex-col" labelledBy="legal-title">
            <div className="shrink-0 flex items-center gap-2 px-4 pt-3.5 pb-2.5 border-b border-separator">
                <h2 id="legal-title" className="text-[15px] font-semibold grow">{active.title}</h2>
                <div className="flex items-center gap-1">
                    <button type="button" className={tabCls(slug === 'terms')} onClick={() => setSlug('terms')}>Terms</button>
                    <button type="button" className={tabCls(slug === 'privacy')} onClick={() => setSlug('privacy')}>Privacy</button>
                </div>
                <SheetClose onClose={onClose} />
            </div>
            <div className="overflow-y-auto px-4 pb-3 text-[13px] leading-relaxed text-label-2">
                <p className="text-label-3 text-xs mt-2.5">
                    {OPERATOR.name} (oddspro.ke) · Version {TERMS_VERSION} · Last updated {active.updated} ·{' '}
                    {/* Explicit index.html: the pretty /privacy/ dir URL falls to the
                        SPA on the vite DEV server; the file path works everywhere. */}
                    <a href={`/${active.slug}/index.html`} target="_blank" rel="noopener" className="text-accent hover:underline">Printable version</a>
                </p>
                {active.sections.map((s, i) => (
                    <CollapseSection key={s.id} title={s.title} defaultOpen={i === 0}>
                        <div className="text-[13px] leading-relaxed text-label-2"><Paras body={s.body} /></div>
                    </CollapseSection>
                ))}
            </div>
        </Sheet>
    );
}
