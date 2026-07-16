import { fetchBetpawaGames } from './betpawa.js';
import { fetchBetikaGames } from './betika.js';
import { fetchApisportsFixtures, settleApisportsResults, fetchApisportsStats, fetchApisportsStandings, fetchApisportsHistory, fetchApisportsPredictions } from './apisports.js';
import { saveMatches, completedMatchIds } from './db/store.js';
import { linkMatches } from './link.js';
import { updatePrematchSnapshots } from './prematch.js';
import { updateHotPicks, performanceSummary } from './hotpicks.js';
import { enrichFixtures } from './enrich.js';
import { exportRecords } from './export.js';
import { backfillGeo } from './geo.js';
import { sendSms, smsBalance, smsDelivery } from './sms/index.js';
import { runStartPipeline } from './pipeline.js';
import { closeDb } from './db/connection.js';
import { _date, _dtime } from './utils.js';

(async () => {
    const args = 'undefined' !== typeof process && Array.isArray(process.argv) ? process.argv : [];
    const script = String(args[1] ?? '').split(/[\\\/]/g).pop();
    if (!script) throw new TypeError('Failed to get process script name!');
    const action = args[2], value = args[3];

    // Default (`npm run start`): full pipeline, today + 3 days ahead.
    // `start [days]` or a bare number (`npm run start -- 5`) overrides the sweep.
    if (!action || action === 'start' || /^\d+$/.test(action)) {
        await runStartPipeline(/^\d+$/.test(action) ? action : value);
        return;
    }

    if (action === 'betpawa' || action === 'betika') {
        const exclude = await completedMatchIds(action, `${_dtime(_date(value)).substring(0, 10)} 00:00:00`);
        const res = action === 'betpawa' ? await fetchBetpawaGames(value, exclude) : await fetchBetikaGames(value, exclude);
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

    if (action === 'history') {
        const c = await fetchApisportsHistory();
        console.debug(`[+] history: ${c.fixtures} fixtures processed, ${c.saved} historical fixtures saved (quota remaining: ${c.quota_remaining}).`);
        return;
    }

    if (action === 'prematch') {
        const c = await updatePrematchSnapshots();
        console.debug(`[+] prematch: ${c.written} snapshots upserted (${c.fixtures} upcoming correlated fixtures).`);
        return;
    }

    if (action === 'predictions') {
        const c = await fetchApisportsPredictions();
        console.debug(`[+] predictions: ${c.fixtures} fixtures processed, ${c.saved} predictions saved (quota remaining: ${c.quota_remaining}).`);
        return;
    }

    if (action === 'hotpicks') {
        const c = await updateHotPicks();
        console.debug(`[+] hotpicks: ${c.settled} settled (${c.tips_settled} tips), ${c.written} evaluated, ${c.hot} hot, `
            + `${c.tips} tips, ${c.tips_skipped} skipped ineligible `
            + `(AI hot: ${c.ai.confirmed}/${c.ai.vetoed}/${c.ai.errors} confirmed/vetoed/errors; `
            + `AI tips: ${c.tip_ai.confirmed}/${c.tip_ai.vetoed}/${c.tip_ai.errors}).`);
        return;
    }

    if (action === 'enrich') {
        const r = await enrichFixtures();
        console.debug(`[+] enrich: ${r.fixtures} fixtures, ${r.written} insights written, ${r.errors} errors, ${r.skipped} over cap.`);
        return;
    }

    if (action === 'performance') {
        const p = await performanceSummary();
        // Flat tables: one row per window / bucket, per pick stream
        const _rows = (label, blocks) => Object.entries(blocks).map(([key, s]) => ({
            [label]: key, picks: s.picks, hits: s.hits, misses: s.misses, pending: s.pending,
            'hit-rate': s.rate == null ? '-' : `${(s.rate * 100).toFixed(1)}%`,
            'avg price': s.avg_price ?? '-',
            'break-even': s.break_even == null ? '-' : `${(s.break_even * 100).toFixed(1)}%`,
            profit: s.profit, roi: s.roi == null ? '-' : `${(s.roi * 100).toFixed(1)}%`,
        }));
        for (const [name, stream] of [['TIPS', p.tips], ['HOT PICKS (O 2.5)', p.hotpicks]]) {
            console.log(`\n=== ${name} - flat-stake performance (1 unit/pick) ===`);
            console.table(_rows('window', stream.windows));
            for (const [bucket, blocks] of Object.entries(stream.buckets)) {
                console.log(`--- by ${bucket} (all time) ---`);
                console.table(_rows(bucket, blocks));
            }
            const v = stream.ai_impact.vetoed;
            console.log(`--- AI-vetoed (excluded above): ${v.picks} picks, `
                + `${v.hits}/${v.misses} hit/miss, profit ${v.profit} -> veto saved ${stream.ai_impact.saved} units ---`);
        }
        return;
    }

    if (action === 'export') {
        const c = await exportRecords(value);
        console.debug(`[+] export: ${c.rows} correlated records (${c.date}) -> ${c.file}`);
        return;
    }

    if (action === 'results') {
        const c = await settleApisportsResults();
        console.debug(`[+] results: ${c.refreshed} fixtures refreshed, ${c.settled} matches settled, ${c.fallback_completed} fallback-completed (quota remaining: ${c.quota_remaining}).`);
        return;
    }

    if (action === 'geo') {
        const c = await backfillGeo();
        console.debug(`[+] geo: ${c.discovered} new IP(s) - ${c.resolved} resolved, ${c.unresolvable} unresolvable, ${c.private} private; ${c.applied ?? 0} visit rows updated.`);
        return;
    }

    if (action === 'sms') {
        // sms balance | sms delivery <unique_id> | sms send <phone> <text...>
        if (value === 'balance') {
            console.debug('[+] sms balance:', await smsBalance());
        } else if (value === 'delivery') {
            if (!args[4]) throw new TypeError('Usage: sms delivery <unique_id>');
            console.debug('[+] sms delivery:', await smsDelivery(args[4]));
        } else if (value === 'send') {
            if (!args[4]) throw new TypeError('Usage: sms send <+E164phone> <text...>');
            const text = args.slice(5).join(' ') || 'Odds Pro test message';
            console.debug('[+] sms send:', await sendSms({ to: args[4], text }));
        } else {
            console.warn('Usage: node src/index.js sms <balance | delivery <unique_id> | send <+phone> <text>>');
        }
        return;
    }

    console.warn(`[!] Unsupported action: ${action}`);
})()
.catch(e => {
    process.exitCode = 1;
    console.error(e);
})
.finally(() => closeDb());
