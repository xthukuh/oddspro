import Fs from 'fs';
import { fetchBetpawaGames } from './betpawa.js';
import { fetchBetikaGames } from './betika.js';

(async () => {
    const args = 'undefined' !== typeof process && Array.isArray(process.argv) ? process.argv : [];
    const script = String(args[1] ?? '').split(/[\\\/]/g).pop();
    if (!script) throw new TypeError('Failed to get process script name!');
    const action = args[2], value = args[3];

    console.debug({'process.stdout.isTTY': process.stdout.isTTY});

    if (action === 'betpawa') {
        const res = await fetchBetpawaGames(value);
        console.debug(`Found ${res.length} games.`);

        const file = `x-${action}-output.xx.json`;
        const txt = JSON.stringify(res, undefined, 4);
        Fs.writeFileSync(file, txt);
        console.debug(`[+]  ${file} (${txt.length})`);
        return;
    }
    
    if (action === 'betika') {
        const res = await fetchBetikaGames(value);
        console.debug(`Found ${res.length} games.`);

        const file = `x-${action}-output.xx.json`;
        const txt = JSON.stringify(res, undefined, 4);
        Fs.writeFileSync(file, txt);
        console.debug(`[+]  ${file} (${txt.length})`);
        return;
    }

    console.warn(`[!] Unsupported action: ${action}`);
})();
