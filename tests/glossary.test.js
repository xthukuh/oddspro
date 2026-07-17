// Help-dialog glossary data (web/src/glossary.js): shape guards, the no-drift
// rule - market entries must reuse tipMarketLabel()'s exact wording - and the
// web-copy ban on em/en dashes. Pure data, no .env/DB.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GLOSSARY } from '../web/src/glossary.js';
import { tipMarketLabel } from '../src/db/magic-rules.js';

test('glossary: four categories, each well-formed', () => {
    assert.deepEqual(GLOSSARY.map(g => g.id), ['markets', 'pricing', 'performance', 'app']);
    for (const g of GLOSSARY) {
        assert.ok(typeof g.title === 'string' && g.title.length > 0, `${g.id} title`);
        assert.ok(Array.isArray(g.terms) && g.terms.length > 0, `${g.id} terms`);
        for (const t of g.terms) {
            assert.ok(typeof t.term === 'string' && t.term.length > 0, `${g.id} term`);
            assert.ok(typeof t.def === 'string' && t.def.length > 0, `${g.id} ${t.term} def`);
        }
    }
});

test('glossary: terms unique within each category', () => {
    for (const g of GLOSSARY) {
        const names = g.terms.map(t => t.term);
        assert.equal(new Set(names).size, names.length, g.id);
    }
});

test('glossary: market entries reuse tipMarketLabel wording verbatim', () => {
    const keyed = GLOSSARY.flatMap(g => g.terms).filter(t => t.key);
    assert.ok(keyed.length >= 10, 'market codes should carry keys');
    for (const t of keyed) {
        assert.equal(t.name, tipMarketLabel(t.key), t.term);
    }
});

test('glossary: no em/en dashes anywhere (web copy rule)', () => {
    for (const g of GLOSSARY) {
        for (const t of g.terms) {
            for (const s of [t.term, t.name ?? '', t.def]) {
                assert.ok(!/[–—]/.test(s), `${g.id} ${t.term}: "${s}"`);
            }
        }
    }
});
