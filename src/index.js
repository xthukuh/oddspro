import { fetchBetpawaGames } from './betpawa.js';
import { fetchBetikaGames } from './betika.js';
import { fetchApisportsFixtures, settleApisportsResults, fetchApisportsStats, fetchApisportsStandings } from './apisports.js';
import { saveMatches } from './db/store.js';
import { linkMatches } from './link.js';
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
        await linkMatches(action); // auto-correlate new matches
        return;
    }

    if (action === 'fixtures') {
        const c = await fetchApisportsFixtures(value);
        console.debug(`[+] fixtures: ${c.fixtures} fixtures, ${c.leagues} leagues, ${c.teams} teams upserted (quota remaining: ${c.quota_remaining}).`);
        await linkMatches(); // auto-correlate against the new canonical fixtures
        return;
    }

    if (action === 'link') {
        await linkMatches(value === 'betpawa' || value === 'betika' ? value : null);
        return;
    }

    if (action === 'stats') {
        const c = await fetchApisportsStats();
        console.debug(`[+] stats: ${c.fixtures} fixtures processed - ${c.statistics} statistics, ${c.lineups} lineups (${c.players} players), ${c.events} events (quota remaining: ${c.quota_remaining}).`);
        return;
    }

    if (action === 'standings') {
        const c = await fetchApisportsStandings();
        console.debug(`[+] standings: ${c.leagues} league/seasons, ${c.rows} rows saved, ${c.empty} without tables (quota remaining: ${c.quota_remaining}).`);
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
