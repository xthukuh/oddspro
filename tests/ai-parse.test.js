// Gemini reply decoding for the AI adjudicators (src/ai-parse.js): envelope
// validation, fence-tolerant v2 verdict extraction, probability
// normalization and grounding-citation collection. Pure module - no .env.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAiReply, parseVerdict, extractJson } from '../src/ai-parse.js';

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

// parseVerdict: the text-level half of parseAiReply (T3 split) - takes the
// raw reply TEXT, not the Gemini envelope, so provider-agnostic callers
// (the AI-review worker via complete(), later the harness) can decode a
// verdict without pretending their reply came from Gemini.
test('parseVerdict decodes a verdict from raw reply text', () => {
    const out = parseVerdict(JSON.stringify({
        verdict: 'confirm', probability: 72, reason: 'Solid form both sides.',
    }));
    assert.equal(out.verdict, 'confirm');
    assert.equal(out.probability, 0.72, 'percent replies normalize to 0..1');
    assert.equal(out.reason, 'Solid form both sides.');
    assert.equal('sources' in out, false, 'text-level: sources belong to the envelope layer');
});

test('parseVerdict throws on junk and on out-of-vocabulary verdicts', () => {
    assert.throws(() => parseVerdict('no json here at all'));
    assert.throws(() => parseVerdict('{"verdict":"maybe"}'));
});

test('parseAiReply still composes envelope + verdict identically after the split', () => {
    const out = parseAiReply(envelope('```json\n{"verdict":"veto","reason":"r"}\n```',
        [{ web: { uri: 'https://x', title: 't' } }]));
    assert.equal(out.verdict, 'veto');
    assert.deepEqual(out.sources, [{ title: 't', uri: 'https://x' }]);
});

// extractJson hardening (2026-08-19): production logged a run of
// "Expected ',' or '}' after property value" failures because the old greedy
// /\{[\s\S]*\}/ spanned from the first brace anywhere in the reply to the last.
test('extractJson ignores a prose preamble that itself contains braces', () => {
    const reply = 'I will answer in the shape {probability, verdict} as asked.\n'
        + '{"verdict":"confirm","reason":"ok"}';
    assert.deepEqual(extractJson(reply), { verdict: 'confirm', reason: 'ok' });
});

test('extractJson takes the last object when the model restates then answers', () => {
    const reply = '{"schema":"example"}\nHere is the verdict:\n{"verdict":"veto","reason":"r"}';
    assert.deepEqual(extractJson(reply), { verdict: 'veto', reason: 'r' });
});

test('extractJson keeps braces and escaped quotes inside string values', () => {
    const reply = '```json\n{"reason":"the model said {\\"x\\":1} verbatim","verdict":"confirm"}\n```';
    assert.deepEqual(extractJson(reply),
        { reason: 'the model said {"x":1} verbatim', verdict: 'confirm' });
});

test('extractJson parses nested objects and arrays', () => {
    const reply = 'prose {\n{"verdict":"confirm","checks":[{"name":"a","finding":"f"}]}';
    assert.deepEqual(extractJson(reply).checks, [{ name: 'a', finding: 'f' }]);
});

test('extractJson throws on a reply the model cut mid-object', () => {
    assert.throws(() => extractJson('{"verdict":"confirm","reason":"cut off here'),
        /carried no JSON object/);
});

test('extractJson error quotes a bounded slice of the offending reply', () => {
    const junk = `{"a":${'x'.repeat(900)}}`;
    assert.throws(() => extractJson(junk), e => e.message.length < 700);
});
