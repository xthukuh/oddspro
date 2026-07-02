import { fetchBetpawaGames } from './betpawa.js';
import { fetchBetikaGames } from './betika.js';
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

    console.warn(`[!] Unsupported action: ${action}`);
})()
.catch(e => {
    process.exitCode = 1;
    console.error(e);
})
.finally(() => closeDb());
