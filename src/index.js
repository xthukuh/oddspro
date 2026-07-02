import { fetchBetpawaGames } from './betpawa.js';
import { fetchBetikaGames } from './betika.js';
import { fetchApisportsFixtures, settleApisportsResults } from './apisports.js';
import { saveMatches } from './db/store.js';
import { closeDb } from './db/connection.js';

(async () => {
    const args = 'undefined' !== typeof process && Array.isArray(process.argv) ? process.argv : [];
    const script = String(args[1] ?? '').split(/[\\\/]/g).pop();
    if (!script) throw new TypeError('Failed to get process script name!');
    const action = args[2], value = args[3];

    if (action === 'betpawa' || action === 'betika') {
        const res = action === 'betpawa' ? await fetchBetpawaGames(value) : await fetchBetikaGames(value);
        console.debug(`Found ${res.length} games.`);
        const c = await saveMatches(res);
        console.debug(`[+] ${action}: ${c.inserted} inserted, ${c.updated} updated, ${c.skipped} skipped (completed), ${c.markets} odds market rows saved.`);
        return;
    }

    if (action === 'fixtures') {
        const c = await fetchApisportsFixtures(value);
        console.debug(`[+] fixtures: ${c.fixtures} fixtures, ${c.leagues} leagues, ${c.teams} teams upserted (quota remaining: ${c.quota_remaining}).`);
        return;
    }

    if (action === 'results') {
        const c = await settleApisportsResults();
        console.debug(`[+] results: ${c.refreshed} fixtures refreshed, ${c.settled} matches settled, ${c.fallback_completed} fallback-completed (quota remaining: ${c.quota_remaining}).`);
        return;
    }

    console.warn(`[!] Unsupported action: ${action}`);
})()
.catch(e => {
    process.exitCode = 1;
    console.error(e);
})
.finally(() => closeDb());
