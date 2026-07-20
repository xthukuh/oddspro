// AI-scorecard loader - the performanceSummary() idiom (src/hotpicks.js): one
// query scan per ledger, delegate everything computable to the pure
// src/db/scorecard-rules.js. Backs `node scripts/ai-scorecard.js` and (M11)
// GET /api/admin/perf/scorecard.
import { db } from './db/connection.js';
import { config } from './config.js';
import { FINAL_STATUSES } from './apisports.js';
import { computeScorecard } from './db/scorecard-rules.js';

export async function scorecardSummary() {
    // ---------- the adjudication ledger (one scan; settled + pending) ----------
    const picks = await db('fixture_predictions as p')
        .join('fixtures as f', 'f.id', 'p.fixture_id')
        .select('p.fixture_id', 'p.hot', 'p.outcome', 'p.over_price',
            'p.ai_verdict', 'p.ai_model', 'p.ai_review',
            'p.tip_market', 'p.tip_price', 'p.tip_confidence', 'p.tip_outcome',
            'p.tip_ai_verdict', 'p.tip_ai_model', 'p.tip_ai_review',
            db.raw("DATE_FORMAT(f.kickoff,'%Y-%m-%d') as day"));

    // ---------- settled blind insights (for S3) ----------
    const insights = await db('fixture_ai_insights as i')
        .join('fixtures as f', 'f.id', 'i.fixture_id')
        .where('i.kind', 'blind')
        .whereIn('f.status', FINAL_STATUSES)
        .whereNotNull('f.ft_home').whereNotNull('f.ft_away')
        .select('i.model_tag', 'i.payload', 'f.ft_home', 'f.ft_away');

    return computeScorecard({
        picks, insights,
        tipAiMinConfidence: config.TIP_AI_MIN_CONFIDENCE,
        tipAiReusePriceTol: config.TIP_AI_REUSE_PRICE_TOL,
    });
}
