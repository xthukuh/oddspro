import axios from 'axios';
import { _date, _dtime, _batch } from './utils.js';

// Get axios client instance
const BetikaClient = axios.create({
    baseURL: process.env.BETIKA_BASE_URL ?? 'https://api.betika.com/v1/uo',
    headers: {
        'accept': 'application/json, text/plain, */*',
        'accept-encoding': 'gzip, deflate, br, zstd',
        'accept-language': 'en-GB,en-US;q=0.9,en;q=0.8',
        'cache-control': 'no-cache',
        'dnt': 1,
        'origin': 'https://www.betika.com',
        'pragma': 'no-cache',
        'priority': 'u=1, i',
        'referer': 'https://www.betika.com/',
        'sec-ch-ua': '"Google Chrome";v="149", "Chromium";v="149", "Not)A;Brand";v="24"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-site',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
    },
    timeout: 30_000,
});


// Parse game details to standard structure
function parseBetikaGame(game) {
    const result = {
        provider: 'betika',
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

    // parse markets
    let v;
    const markets = [];
    if (Array.isArray(game.odds)) {
        for (const a of game.odds) {
            if (!Array.isArray(a.odds)) continue;
            for (const b of a.odds) {
                markets.push({
                    type_id: Number(a.sub_type_id),
                    type_name: a.name,
                    type_explainer: null,
                    name: b.display,
                    price: Number(Number(b.odd_value).toFixed(2)),
                    handicap: /\d/.test(v = String(b.parsed_special_bet_value?.total ?? '')) ? Number(Number(v).toFixed(1)) : null,
                    probability: null,
                });
            }
        }
    }

    // NOTE: In betika standardized record object, the following fields will always be null (this data is not available): `home_team_id, away_team_id, region_id, region_name, category_id, competition_id`.
    // populate result
    result.match_id = (v = Number(game.parent_match_id));
    result.match_url = `https://www.betika.com/en-ke/m/${v}`;
    result.start_time = _dtime(game.start_time).substring(0, 16); // YYYY-MM-DD HH:mm
    result.home_team_id = null;
    result.home_team_name = game.home_team;
    result.home_score_first_half = null;
    result.home_score_second_half = null;
    result.home_score_fulltime = null;
    result.away_team_id = null;
    result.away_team_name = game.away_team;
    result.away_score_first_half = null;
    result.away_score_second_half = null;
    result.away_score_fulltime = null;
    result.region_id = null;
    result.region_name = null;
    result.category_id = null;
    result.category_name = game.category ?? null;
    result.competition_id = null;
    result.competition_name = game.competition_name ?? null;
    result.markets = markets;
    result.metadata = JSON.stringify(game);
    return result;
}

// Fetch games with their available odds markets
export async function fetchBetikaGames(date_=null) {
    const date = _date(date_), dt = _dtime(date).substring(0, 10), sub_type_id = 1, limit = 10;
    const dates = Object.fromEntries([...Array(8)].map((_, i) => [new Date(new Date().setDate(new Date().getDate() + i)).toISOString().substring(0, 10), i?i:-1]));
    const period = dates[dt];
    if (!period) {
        console.warn(`Unsupported date period: ${dt}`);
        return [];
    }
    console.debug(`Betika ${dt} (${period}) - Fetch games...`);
    const buffer = [];
    const _next = async (page = 1) => {
        const path = `/matches?page=${page}&limit=${limit}&tab=upcoming&sub_type_id=${sub_type_id}&sport_id=14,139&sort_id=2&period_id=${period}&esports=false`;
        const { data } = await BetikaClient.get(path);
        const arr = Array.isArray(data.data) ? data.data : [];
        const len = arr.length;
        buffer.push(...arr);
        if (len < limit) return buffer;
        await new Promise(r => setTimeout(r, 50));
        return _next(++page);
    };
    const items = await _next();
    console.debug(`Betika ${dt} - Found ${items.length} games...`);

    const games = [];
    await _batch(items, async (g, i) => {
        const { data } = await BetikaClient.get('/match?parent_match_id=' + g.parent_match_id);
        const {odds: _, ...rest} = g;
        games[i] = parseBetikaGame({...rest, ...Object(data.meta), odds: data.data});
    }, 10);
    return games;
}
