// BetPawa's live Win Bonus configuration (Sharp 4x card, 2026-10-15), in
// its own module so the Sharp card depends on nothing else in the scraper.
// BetPawa serves it in its public brand data; reading it per build means a
// change on their side (give-back share, leg caps) reaches the card with no
// code edit. Returns the shape of BETPAWA_KE_BONUS
// (src/db/betpawa-bonus-rules.js) or null when the fetch or the schema
// fails - callers fall back to the verified constants.
import axios from 'axios';
import { z } from 'zod';

const BRAND_DATA_URL = 'https://www.betpawa.co.ke/api/preference/v1/brand-component-data?language=en';
const HEADERS = {
    Accept: 'application/json',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
    'x-pawa-brand': 'betpawa-kenya',
    'x-pawa-language': 'en',
};

const _BonusSchema = z.object({
    minEligibleItemPrice: z.number().positive(),
    minimumHouseEV: z.number(),
    itemMarginReductionFactor: z.number().positive(),
    minItemMargin: z.number(),
    maxItemMargin: z.number(),
    houseEVToGiveBackToPunter: z.number().min(0).max(1),
    minMaxMultipliers: z.array(z.object({
        legs: z.number().int().positive(),
        minMultiplier: z.number(),
        maxMultiplier: z.number(),
    })).min(1),
});

function _findKey(o, key, depth = 0) {
    if (!o || typeof o !== 'object' || depth > 8) return undefined;
    if (Object.prototype.hasOwnProperty.call(o, key)) return o[key];
    for (const v of Object.values(o)) {
        const r = _findKey(v, key, depth + 1);
        if (r !== undefined) return r;
    }
    return undefined;
}

export async function fetchBetpawaBonusConfig({ timeout = 15_000 } = {}) {
    try {
        const { data } = await axios.get(BRAND_DATA_URL, { headers: HEADERS, timeout });
        const parsed = _BonusSchema.safeParse(_findKey(data, 'dynamicBonus'));
        if (!parsed.success) return null;
        const c = parsed.data;
        return {
            minEligibleItemPrice: c.minEligibleItemPrice,
            minimumHouseEV: c.minimumHouseEV,
            itemMarginReductionFactor: c.itemMarginReductionFactor,
            minItemMargin: c.minItemMargin,
            maxItemMargin: c.maxItemMargin,
            houseEVToGiveBackToPunter: c.houseEVToGiveBackToPunter,
            maxMultipliers: c.minMaxMultipliers.map(m => [m.legs, m.maxMultiplier]),
        };
    } catch {
        return null;
    }
}
