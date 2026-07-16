// M4.1 enrichment selection rules. The leakage assertion here is the
// highest-severity guard in the milestone: a grounded call on a played fixture
// google-searches the final score, and the failure is SILENT and FLATTERS.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectEnrichable, capFixtures } from '../src/db/ai-rules.js';

const NOW = new Date('2026-07-16T12:00:00Z').getTime();

test('selectEnrichable rejects every past-kickoff fixture (LEAKAGE GUARD)', () => {
    const rows = [
        { id: 1, kickoff: '2026-07-16T11:59:00Z' }, // 1 min ago - still leakage
        { id: 2, kickoff: '2026-07-16T12:00:00Z' }, // exactly now - not future
        { id: 3, kickoff: '2026-07-16T12:01:00Z' }, // future - the only legal one
    ];
    assert.deepEqual(selectEnrichable(rows, NOW).map(r => r.id), [3]);
});

test('selectEnrichable takes soonest-kickoff first', () => {
    const rows = [
        { id: 1, kickoff: '2026-07-18T12:00:00Z' },
        { id: 2, kickoff: '2026-07-17T12:00:00Z' },
        { id: 3, kickoff: '2026-07-16T18:00:00Z' },
    ];
    assert.deepEqual(selectEnrichable(rows, NOW).map(r => r.id), [3, 2, 1]);
});

test('capFixtures bounds FIXTURES, never truncating one mid-set', () => {
    const rows = [{ id: 1 }, { id: 2 }, { id: 3 }];
    assert.deepEqual(capFixtures(rows, 2).map(r => r.id), [1, 2]);
    assert.equal(capFixtures(rows, 0).length, 0);
    assert.equal(capFixtures(rows, 99).length, 3);
});
