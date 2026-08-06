import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeModel, parseCatalog, parseEndpoints } from '../src/modeltriage/catalog.js';

// Offline tests for the tolerant OpenRouter catalog normalization (zod-only -
// no network; fetchCatalog/fetchEndpoints are thin HTTP wrappers over these).

const RAW = {
    id: 'openai/gpt-5.6-luna',
    name: 'OpenAI: GPT-5.6 Luna',
    created: 1751000000,
    context_length: 400000,
    pricing: { prompt: '0.00000125', completion: '0.00001', web_search: '0.005' },
    supported_parameters: ['temperature', 'tools', 'structured_outputs', 'response_format'],
};

test('normalizeModel maps the live API shape: numbers from pricing strings, vendor, flags', () => {
    const m = normalizeModel(RAW);
    assert.equal(m.id, 'openai/gpt-5.6-luna');
    assert.equal(m.vendor, 'openai');
    assert.equal(m.context, 400000);
    assert.equal(m.pricing.prompt, 0.00000125);
    assert.equal(m.pricing.completion, 0.00001);
    assert.equal(m.pricing.web_search, 0.005);
    assert.equal(m.structured, true);
    assert.equal(m.tools, true);
    assert.equal(m.free, false);
    assert.equal(m.aa, null); // no benchmark block in this row
});

test('normalizeModel: :free suffix and zero pricing set the free flag', () => {
    const m = normalizeModel({ ...RAW, id: 'nvidia/nemotron-3:free', pricing: { prompt: '0', completion: '0' } });
    assert.equal(m.free, true);
});

test('normalizeModel: structured falls back to response_format alone; tools absence detected', () => {
    const m = normalizeModel({ ...RAW, supported_parameters: ['response_format'] });
    assert.equal(m.structured, true);
    assert.equal(m.tools, false);
});

test('normalizeModel tolerates missing pricing/params/context and junk rows', () => {
    const m = normalizeModel({ id: 'x/y', name: 'X' });
    assert.equal(m.context, null);
    assert.deepEqual(m.pricing, { prompt: null, completion: null, web_search: null });
    assert.equal(m.structured, false);
    assert.equal(m.aa, null);
    assert.equal(normalizeModel({ name: 'no id' }), null);
    assert.equal(normalizeModel(null), null);
});

test('normalizeModel extracts the AA intelligence index from the known paths', () => {
    assert.equal(normalizeModel({ ...RAW, benchmarks: { artificial_analysis: { intelligence_index: 62 } } }).aa, 62);
    assert.equal(normalizeModel({ ...RAW, artificial_analysis: { intelligence_index: '58' } }).aa, 58);
    assert.equal(normalizeModel({ ...RAW, aa_intelligence_index: 44 }).aa, 44);
    // Junk index degrades to null, never a throw.
    assert.equal(normalizeModel({ ...RAW, benchmarks: { artificial_analysis: { intelligence_index: 'n/a' } } }).aa, null);
});

test('parseCatalog: data array normalized, junk rows dropped, non-object reply -> []', () => {
    const out = parseCatalog({ data: [RAW, { no: 'id' }, null, { ...RAW, id: 'b/two' }] });
    assert.deepEqual(out.map(m => m.id), ['openai/gpt-5.6-luna', 'b/two']);
    assert.deepEqual(parseCatalog(null), []);
    assert.deepEqual(parseCatalog({ data: 'nope' }), []);
});

test('parseEndpoints: best uptime across endpoints; empty/junk -> null', () => {
    const out = parseEndpoints({ data: { endpoints: [
        { uptime_last_30m: 97.2 }, { uptime_last_30m: 99.8 }, { uptime_last_30m: null },
    ] } });
    assert.equal(out.uptime, 99.8);
    assert.equal(parseEndpoints({ data: { endpoints: [] } }), null);
    assert.equal(parseEndpoints({}), null);
    assert.equal(parseEndpoints(null), null);
});
