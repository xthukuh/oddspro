// anchored-weekly.mjs - weekly read-only reading of the Sharp-anchored Pick
// shadow forward test (docs/engine/05-RANKING.md "Sharp-anchored Pick shadow").
//
// Runs scripts/report-anchored.js ON THE LIVE HOST (the instrument, against the
// live anchored_picks table) in one short ssh call, keeps its JSON there as the
// durable record (~/ops/anchored/report-<stamp>.json), appends one compact line
// to a ledger on both ends (~/ops/anchored/ledger.ndjson remotely,
// logs/anchored-ledger.ndjson locally) and prints the human report. Nothing on
// the host is edited, restarted or deleted; the bar and the knobs never move
// here (src/db/anchor-rules.js owns the bar, this script only reads it back).
//
// Usage (repo root): node scripts/ops/anchored-weekly.mjs [--dry-run]
// Config: scripts/lib/remote.js (optional .env.deploy overrides; defaults
// already name the live host). Exit 0 on a recorded reading, 1 when the host
// could not be read, so a scheduler can tell silence from success.
import { readFileSync, mkdirSync, appendFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { remoteConfig, ssh } from '../lib/remote.js';

const DRY = process.argv.includes('--dry-run');
const REPO_ROOT = process.cwd();
const version = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).version;
const cfg = remoteConfig({ version });
const OUT = `${cfg.REMOTE_HOME}/ops/anchored`;
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const reportFile = `${OUT}/report-${stamp}.json`;
// The app's own runtime first (what the health cron uses), nvm as the fallback.
const nodeSel = `${cfg.REMOTE_HOME}/nodevenv/oddspro-app-v${version}/22/bin/node`;
const remoteCmd = [
    `cd ${cfg.APP_DIR}`, `mkdir -p ${OUT}`,
    `N=${nodeSel}; [ -x "$N" ] || N=$(ls -d ${cfg.REMOTE_HOME}/.nvm/versions/node/*/bin/node | tail -1)`,
    `$N scripts/report-anchored.js --json ${reportFile} > ${OUT}/last-run.out 2>&1; echo "exit=$?"`,
    'echo "### out"', `cat ${OUT}/last-run.out`,
    'echo "### json"', `cat ${reportFile} 2>/dev/null || echo "{}"`,
].join(' && ');

const pct = v => (v == null || Number.isNaN(v) ? '-' : `${(100 * v).toFixed(1)}%`);
const round = (v, d = 4) => (v == null || Number.isNaN(Number(v)) ? null : Math.round(Number(v) * 10 ** d) / 10 ** d);
const pick = s => (s ? { n: s.n, hits: s.hits, hit: round(s.hitRate), claim: round(s.claim), units: round(s.units, 2), roi: round(s.roi), se: round(s.se), lo95: round(s.lo95) } : null);

let out;
try {
    out = ssh(cfg, remoteCmd, { dry: DRY });
} catch (e) {
    console.error(`[anchored-weekly] host unreachable or report failed: ${e.message}`);
    process.exit(1);
}
if (DRY) process.exit(0);

const text = out.stdout;
const exitLine = /^exit=(\d+)$/m.exec(text);
const humanReport = text.split('### out')[1]?.split('### json')[0]?.trim() ?? '';
const jsonText = text.split('### json')[1]?.trim() ?? '{}';
let report;
try { report = JSON.parse(jsonText); } catch { report = {}; }
if (exitLine?.[1] !== '0' || !report.bar) {
    console.error(`[anchored-weekly] report did not run cleanly (exit=${exitLine?.[1] ?? '?'}):\n${humanReport}`);
    process.exit(1);
}

const checks = Object.fromEntries((report.bar.checks ?? []).map(c => [c.name, { ok: !!c.ok, value: c.value ?? null, need: c.need }]));
const line = {
    at: new Date().toISOString(),
    host_report: reportFile,
    days: report.days?.length ?? 0,
    pool: pick(report.pool), strong: pick(report.strong), card: pick(report.card),
    pass: !!report.bar.pass, checks,
};
const ledgerLine = JSON.stringify(line);

// Local copies (logs/ is gitignored, like every other run artefact).
const logs = path.join(REPO_ROOT, 'logs');
mkdirSync(logs, { recursive: true });
appendFileSync(path.join(logs, 'anchored-ledger.ndjson'), ledgerLine + '\n');
writeFileSync(path.join(logs, 'anchored-last.txt'), `${line.at}\n${humanReport}\n`);

// Host ledger: the line travels base64-encoded as an argument, so no quoting
// hazard and no second file upload (the host resets streamed uploads under load).
const b64 = Buffer.from(ledgerLine + '\n').toString('base64');
let hostLedger = 'not appended';
try {
    ssh(cfg, `printf '%s' '${b64}' | base64 -d >> ${OUT}/ledger.ndjson && wc -l < ${OUT}/ledger.ndjson`);
    hostLedger = 'appended';
} catch (e) {
    hostLedger = `not appended (${e.message.split('\n')[0]})`;
}

console.log(humanReport);
console.log('');
console.log(`ANCHORED ${line.pass ? 'PASS' : 'NOT YET'} days=${line.days} pool n=${line.pool?.n ?? 0} hit ${pct(line.pool?.hit)} vs Pinnacle ${pct(line.pool?.claim)} ROI ${pct(line.pool?.roi)} lower95 ${pct(line.pool?.lo95)}`);
console.log(`ledger: local logs/anchored-ledger.ndjson appended; host ${OUT}/ledger.ndjson ${hostLedger}; report kept at ${reportFile}`);
