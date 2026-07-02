import axios from 'axios';
import { _date, _dtime, _batch, _progress } from './utils.js';

// Get axios client instance
const BetpawaClient = axios.create({
    baseURL: process?.env?.BETPAWA_BASE_URL ?? 'https://www.betpawa.co.ke/api/sportsbook/v4',
    headers: {
        Accept: 'application/json',
        devicetype: 'web',
        dnt: 1,
        referer: 'https://www.betpawa.co.ke/events?marketId=1X2&categoryId=2&day=tomorrow',
        'sec-ch-ua': '"Chromium";v="134", "Not:A-Brand";v="24", "Google Chrome";v="134"',
        'sec-ch-ua-mobile': "?0",
        'sec-ch-ua-platform': '"Windows"',
        traceid: 'ff308908-c15d-4119-b6d3-60ed992a19e0',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
        vuejs: true,
        'x-pawa-brand': 'betpawa-kenya',
        'x-pawa-language': 'en',
    },
    timeout: 30_000,
});


// Parse game details to standard structure
function parseBetpawaGame(game) {
    const result = {
        provider: 'betpawa',
        match_id: null,
        match_url: null,
        start_time: null,
        home_team_id: null,
        home_team_name: null,
        home_score_first_half: null,
        home_score_second_half: null,
        home_score_fulltime: null,
        away_team_id: null,
        away_team_name: null,
        away_score_first_half: null,
        away_score_second_half: null,
        away_score_fulltime: null,
        region_id: null,
        region_name: null,
        category_id: null,
        category_name: null,
        competition_id: null,
        competition_name: null,
        markets: [], // {type_id:number, type_name:string, type_explainer:string|null, name:string, price:number, handicap:number|null, probability:number|null}[]
        metadata: null, // JSON raw game data
    };
    
    // parse results
    if (!(Array.isArray(game?.participants) && game.participants.length === 2)) {
        const err = 'Invalid game participants.';
        console.error(err, {game});
        throw new TypeError(err);
    }
    const home = {
        id: Number(game.participants[0].id),
        name: game.participants[0].name,
        goals: [0, 0, 0],
    };
    const away = {
        id: Number(game.participants[1].id),
        name: game.participants[1].name,
        goals: [0, 0, 0],
    };
    const count = game?.results?.participantPeriodResults?.length || 0;
    if (count) {
        const teams = {home, away};
        for (const pp of game.results.participantPeriodResults) {
            const team = teams[pp.participant.type.toLowerCase()];
            if (Array.isArray(pp.periodResults)) {
                for (const pr of pp.periodResults) {
                    const n = pr.period.name, g = Number(pr.result);
                    if (/^full/i.test(n)) team.goals[0] = g;
                    else if (/^second/i.test(n)) team.goals[1] = g;
                    else if (/^first/i.test(n)) team.goals[2] = g;
                }
            }
        }
    }

    // parse markets
    let v;
    const markets = [];
    if (Array.isArray(game.markets)) {
        for (const m of game.markets) {
            for (const row of m.row) {
                for (const p of row.prices) {
                    markets.push({
                        type_id: Number(m.marketType.id),
                        type_name: m.marketType.displayName,
                        type_explainer: m.marketType.explainer,
                        name: p.name,
                        price: Number(Number(p.odds).toFixed(2)),
                        handicap: /\d/.test(v = String(p.handicap)) ? Number(Number(v).toFixed(1)) : null,
                        probability: /\d/.test(v = String(p.probability?.win ?? '')) ? Number(Number(v).toFixed(3)) : null,
                    });
                }
            }
        }
    }

    // populate result
    result.match_id = (v = Number(game.id));
    result.match_url = `https://www.betpawa.co.ke/event/${v}?filter=all`;
    result.start_time = _dtime(game.startTime).substring(0, 16); // YYYY-MM-DD HH:mm
    result.home_team_id = home.id;
    result.home_team_name = home.name;
    result.home_score_first_half = home.goals[2];
    result.home_score_second_half = home.goals[1];
    result.home_score_fulltime = home.goals[0];
    result.away_team_id = away.id;
    result.away_team_name = away.name;
    result.away_score_first_half = away.goals[2];
    result.away_score_second_half = away.goals[1];
    result.away_score_fulltime = away.goals[0];
    result.region_id = /\d/.test(v = String(game.region?.id ?? '')) ? Number(v) : null;
    result.region_name = game.region?.name ?? null;
    result.category_id = /\d/.test(v = String(game.category?.id ?? '')) ? Number(v) : null;
    result.category_name = game.category?.name ?? null;
    result.competition_id = /\d/.test(v = String(game.competition?.id ?? '')) ? Number(v) : null;
    result.competition_name = game.competition?.name ?? null;
    result.markets = markets;
    result.metadata = JSON.stringify(game);
    return result;
}

// Fetch games with their available odds markets.
// `exclude_` (optional Set of provider match ids) skips already-completed
// matches before their per-game detail requests - fewer server hits.
export async function fetchBetpawaGames(date_=null, exclude_=null) {
    const date = _date(date_), dt = _dtime(date).substring(0, 10), take = 50, limit = 0;
    if (date.getTime() < new Date(_dtime(new Date()).substring(0, 10) + ' 00:00:00').getTime()) {
        console.warn(`Unsupported date period: ${dt}`);
        return [];
    }
    const gte = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0).toISOString();
    const lt = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999).toISOString();
    console.debug(`BetPawa ${lt.substring(0, 10)} - Fetch games...`);

    let count = 0, buffer = [], _next = async (skip=0) => {
        const res = await BetpawaClient.get('/events/lists/by-queries?q=' + encodeURIComponent(
            '{"queries":[{'
            + '"query":{"eventType":"UPCOMING","categories":["2"],"zones":{},"hasOdds":true,'
            + `"startTime":{"gte":"${gte}","lt":"${lt}"}},`
            + '"view":{"marketTypes":["3743","28000810","28000850","4693","1096755","3795"]},'
            + `"skip":${skip},`
            + `"take":${take}`
            + '}]}'
        ))
        .catch(e => {
            console.warn(`[_get] failure: ${e}`, {error: e});
            return {error: e};
        });
        let arr = res.data?.responses?.[0]?.responses;
        if (!Array.isArray(arr)) arr = [];
        const len = arr.length;
        let done = len < take;
        count += len;
        if (limit > 0 && count >= limit) {
            arr = arr.splice(0, len - (len - (count - limit)));
            done = true;
        }
        buffer.push(...arr);
        if (!done) return new Promise(resolve=>setTimeout(resolve,50)).then(()=>_next(skip + take));
        return buffer;
    };
    
    let items = await _next();
    console.debug(`BetPawa ${lt.substring(0, 10)} - Found ${items.length} games...`);
    if (exclude_ instanceof Set && exclude_.size) {
        const before = items.length;
        items = items.filter(g => !exclude_.has(Number(g.id)));
        if (items.length < before) console.debug(`BetPawa ${lt.substring(0, 10)} - Skipped ${before - items.length} completed games (no detail requests).`);
    }

    const games = [];
    const tick = _progress(`BetPawa ${lt.substring(0, 10)} - details`);
    await _batch(items, async (g, i, len) => {
        const { data } = await BetpawaClient.get('https://www.betpawa.co.ke/api/sportsbook/v4/events/' + g.id);
        games[i] = parseBetpawaGame(data);
        tick(len);
    }, 10);
    return games;
}
