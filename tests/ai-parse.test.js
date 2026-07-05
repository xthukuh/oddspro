// Gemini reply decoding for the AI adjudicators (src/ai-parse.js): envelope
// validation, fence-tolerant v2 verdict extraction, probability
// normalization and grounding-citation collection. Pure module - no .env.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAiReply } from '../src/ai-parse.js';

// Minimal envelope factory: reply text (+ optional grounding chunks)
const envelope = (text, grounding) => ({
    candidates: [{
        content: { parts: [{ text }] },
        ...(grounding ? { groundingMetadata: { groundingChunks: grounding } } : {}),
    }],
});

test('parseAiReply decodes a full v2 verdict', () => {
    const out = parseAiReply(envelope(JSON.stringify({
        verdict: 'veto',
        probability: 0.41,
        checks: { context: 'preseason friendly, rotated squads', team_news: 'not verified', market: 'break-even 0.79' },
        reason: 'Preseason friendly with confirmed heavy rotation.',
    })));
    assert.equal(out.verdict, 'veto');
    assert.equal(out.probability, 0.41);
    assert.equal(out.checks.context, 'preseason friendly, rotated squads');
    assert.equal(out.reason, 'Preseason friendly with confirmed heavy rotation.');
    assert.deepEqual(out.sources, []);
});

test('parseAiReply tolerates markdown fences and split parts', () => {
    const data = {
        candidates: [{
            content: {
                parts: [
                    { text: 'Here is my verdict:\n```json\n{"verdict":"con' },
                    { text: 'firm","reason":"No verified red flags."}\n```' },
                ],
            },
        }],
    };
    const out = parseAiReply(data);
    assert.equal(out.verdict, 'confirm');
    assert.equal(out.reason, 'No verified red flags.');
});

test('parseAiReply tolerates omitted probability, checks and reason', () => {
    const out = parseAiReply(envelope('{"verdict":"confirm"}'));
    assert.equal(out.verdict, 'confirm');
    assert.equal(out.probability, null);
    assert.equal(out.checks, null);
    assert.equal(out.reason, '');
});

test('parseAiReply normalizes percentage-style probabilities to 0..1', () => {
    assert.equal(parseAiReply(envelope('{"verdict":"confirm","probability":78}')).probability, 0.78);
    assert.equal(parseAiReply(envelope('{"verdict":"confirm","probability":"0.65"}')).probability, 0.65);
    assert.equal(parseAiReply(envelope('{"verdict":"confirm","probability":1}')).probability, 1);
    assert.equal(parseAiReply(envelope('{"verdict":"confirm","probability":null}')).probability, null);
});

test('parseAiReply collects grounding citations, skipping empty chunks', () => {
    const out = parseAiReply(
        envelope('{"verdict":"veto","reason":"Key striker ruled out."}', [
            { web: { uri: 'https://example.com/news', title: 'example.com' } },
            { web: null },
            {},
        ]),
    );
    assert.deepEqual(out.sources, [{ title: 'example.com', uri: 'https://example.com/news' }]);
});

test('parseAiReply throws on unusable replies (callers fail open)', () => {
    assert.throws(() => parseAiReply(envelope('I cannot judge this fixture.')), /no JSON object/);
    assert.throws(() => parseAiReply(envelope('{"verdict":"maybe"}')));
    assert.throws(() => parseAiReply({ candidates: [] }));
    // Safety-blocked candidate arrives without content at all
    assert.throws(() => parseAiReply({ candidates: [{}] }), /no JSON object/);
});
