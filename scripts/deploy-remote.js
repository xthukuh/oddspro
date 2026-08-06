// SSH deployment orchestrator for the cPanel shared host (v1.4.0 deployment-
// preparedness effort, docs/dev/specs/2026-08-07-0149-*). Automates the manual
// routine documented in docs/DEPLOYMENT.md: upload the package:deploy zips,
// extract the backend into its versioned app root, back up + replace
// public_html, and copy the local database over SSH - all with byte-progress
// on the long transfers (the remote has no pv).
//
// Usage:
//   node scripts/deploy-remote.js --db --fresh     # first deploy of a version:
//                                                  #   full dump -> import -> truncate
//                                                  #   instance tables -> reseed admin
//   node scripts/deploy-remote.js --db             # subsequent: warehouse-only dump
//                                                  #   (instance tables untouched), then
//                                                  #   sessions/otp cleared
//   node scripts/deploy-remote.js --app            # extract backend zip -> app root,
//                                                  #   upload .env.production if absent,
//                                                  #   remote npm install --omit=dev
//   node scripts/deploy-remote.js --web            # tar.gz backup of public_html ->
//                                                  #   wipe -> extract frontend zip
//   node scripts/deploy-remote.js --all [--fresh]  # db + app + web
//   Flags: --dry-run (print the plan, execute nothing remote), --force-env
//   (overwrite the remote .env), --stamp <ts> (pick a specific release stamp).
//
// Config: .env.deploy (gitignored; see .env.deploy.example). Remote paths and
// the DB name derive from package.json's version unless overridden there.
// Remote boundary (owner ruling 2026-08-07): destructive operations only
// inside public_html and deployment-only targets (the versioned app root and
// the deploy-target database). Nothing else is ever deleted.

import { spawn, spawnSync } from 'node:child_process';
import { createReadStream, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

const REPO_ROOT = process.cwd();
const args = process.argv.slice(2);
const has = f => args.includes(f);
const argVal = f => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
const DRY = has('--dry-run');
const doDb = has('--db') || has('--all');
const doApp = has('--app') || has('--all');
const doWeb = has('--web') || has('--all');
const FRESH = has('--fresh');
if (!doDb && !doApp && !doWeb) {
    console.log('Usage: node scripts/deploy-remote.js [--db [--fresh]] [--app] [--web] [--all] [--dry-run] [--force-env] [--stamp <ts>]');
    process.exit(1);
}

// ---- config -----------------------------------------------------------------
const version = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).version;
const dep = existsSync('.env.deploy') ? dotenv.parse(readFileSync('.env.deploy', 'utf8')) : {};
const SSH_TARGET = dep.DEPLOY_SSH || 'oddsprok@oddspro-p';
const REMOTE_HOME = dep.DEPLOY_REMOTE_HOME || '/home2/oddsprok';
const APP_DIR = dep.DEPLOY_APP_DIR || `${REMOTE_HOME}/oddspro-app-v${version}`;
const WEB_DIR = dep.DEPLOY_WEB_DIR || `${REMOTE_HOME}/public_html`;
const DB_NAME = dep.DEPLOY_DB_NAME || `oddsprok_prod_${version.replace(/\./g, '_')}`;
const DB_USER = dep.DEPLOY_DB_USER || 'oddsprok_root';
const DB_PASS = dep.DEPLOY_DB_PASSWORD ?? '';
const NODE_PATH_PREFIX = dep.DEPLOY_NODE_BIN || `${REMOTE_HOME}/.nvm/versions/node/v24.18.0/bin`;
const TMP_DIR = `${REMOTE_HOME}/tmp/deploy`;

// Instance-unique tables: NEVER shipped on subsequent deploys (remote records
// win); TRUNCATED after a --fresh import so the server starts brand-new.
// `settings` is deliberately NOT here - it ships on fresh (carrying the
// migrated .env policy) and is excluded from subsequent dumps below.
const INSTANCE_TABLES = [
    'users', 'sessions', 'otp_codes', 'user_prefs', 'personal_access_tokens',
    'user_slips', 'visits', 'visitors', 'visit_sessions', 'visitor_devices',
    'visit_events', 'ip_geo', 'admin_audit',
    'sms_templates', 'sms_campaigns', 'sms_campaign_recipients',
];
const SUBSEQUENT_IGNORES = [...INSTANCE_TABLES, 'settings'];

function die(msg) { console.error(`[deploy] ERROR: ${msg}`); process.exit(1); }
const fmtMB = b => `${(b / 1048576).toFixed(1)} MB`;

// ---- ssh helpers ------------------------------------------------------------
// Remote commands run under `bash -c` via ssh. DB password goes through the
// environment of the remote command (single-quoted; no single quotes allowed).
if (DB_PASS.includes("'")) die('DEPLOY_DB_PASSWORD may not contain single quotes (remote quoting).');
const MYSQL_ENV = `MYSQL_PWD='${DB_PASS}'`;

function ssh(cmd, { capture = true, allowFail = false } = {}) {
    if (DRY) { console.log(`[dry-run] ssh: ${cmd}`); return { status: 0, stdout: '' }; }
    const r = spawnSync('ssh', ['-o', 'BatchMode=yes', SSH_TARGET, cmd],
        { encoding: 'utf8', stdio: capture ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'inherit', 'inherit'], maxBuffer: 64 * 1048576 });
    if (r.status !== 0 && !allowFail) {
        die(`remote command failed (${r.status}): ${cmd}\n${(r.stderr || '').trim()}`);
    }
    return { status: r.status, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim() };
}

// Run a remote command feeding `input` on stdin - used for every SQL snippet
// so quoting hazards (a scrypt hash's $-runs, backticks) never touch the
// remote shell.
function sshInput(cmd, input, { allowFail = false } = {}) {
    if (DRY) { console.log(`[dry-run] ssh(stdin ${input.length}B): ${cmd}\n${input.split('\n').map(l => `    | ${l}`).join('\n')}`); return { status: 0, stdout: '' }; }
    const r = spawnSync('ssh', ['-o', 'BatchMode=yes', SSH_TARGET, cmd],
        { encoding: 'utf8', input, maxBuffer: 64 * 1048576 });
    if (r.status !== 0 && !allowFail) {
        die(`remote command failed (${r.status}): ${cmd}\n${(r.stderr || '').trim()}`);
    }
    return { status: r.status, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim() };
}

// Stream a local file into `remoteCmd`'s stdin with a byte-progress meter.
function sshStream(localFile, remoteCmd, label) {
    if (DRY) { console.log(`[dry-run] stream ${localFile} -> ssh: ${remoteCmd}`); return Promise.resolve(); }
    const total = statSync(localFile).size;
    const started = Date.now();
    let sent = 0, lastDraw = 0;
    const child = spawn('ssh', ['-o', 'BatchMode=yes', SSH_TARGET, remoteCmd], { stdio: ['pipe', 'inherit', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', d => stderr += d);
    const src = createReadStream(localFile, { highWaterMark: 1048576 });
    src.on('data', chunk => {
        sent += chunk.length;
        const now = Date.now();
        if (now - lastDraw > 250 || sent === total) {
            lastDraw = now;
            const pct = (sent / total * 100).toFixed(1);
            const secs = (now - started) / 1000;
            const rate = sent / Math.max(secs, 0.001) / 1048576;
            const eta = rate > 0 ? Math.max(0, (total - sent) / (rate * 1048576)) : 0;
            process.stdout.write(`\r[deploy] ${label}: ${pct}%  ${fmtMB(sent)}/${fmtMB(total)}  ${rate.toFixed(2)} MB/s  ETA ${Math.ceil(eta)}s   `);
        }
    });
    src.pipe(child.stdin);
    return new Promise((resolve, reject) => {
        child.on('error', e => reject(new Error(`ssh failed to start: ${e.message}`)));
        child.on('close', code => {
            process.stdout.write('\n');
            if (code !== 0) reject(new Error(`${label} failed (exit ${code}): ${stderr.trim()}`));
            else resolve();
        });
    });
}

// ---- release artifacts ------------------------------------------------------
function latestRelease() {
    const relDir = path.join(REPO_ROOT, 'release');
    if (!existsSync(relDir)) return null;
    const stamps = new Map();
    for (const f of readdirSync(relDir)) {
        const m = f.match(/^oddspro-(app|web)_(\d{8}_\d{6})\.zip$/);
        if (m) stamps.set(m[2], (stamps.get(m[2]) || new Set()).add(m[1]));
    }
    const want = argVal('--stamp');
    const complete = [...stamps.entries()].filter(([, kinds]) => kinds.has('app') && kinds.has('web')).map(([s]) => s).sort();
    const stamp = want || complete[complete.length - 1];
    if (!stamp || !stamps.get(stamp)) return null;
    return {
        stamp,
        app: path.join(relDir, `oddspro-app_${stamp}.zip`),
        web: path.join(relDir, `oddspro-web_${stamp}.zip`),
    };
}

// ---- steps ------------------------------------------------------------------
async function stepDb() {
    console.log(`\n[deploy] === DB ${FRESH ? '(FRESH)' : '(subsequent)'} -> ${DB_NAME} ===`);
    const { exportDb } = await import('./db-export.js');
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '_');
    const dumpPath = path.join(REPO_ROOT, 'backups', `oddspro-deploy_${stamp}.sql.gz`);
    const ignoreTables = FRESH ? [] : SUBSEQUENT_IGNORES;
    if (!FRESH) console.log(`[deploy] excluding instance tables from the dump: ${ignoreTables.join(', ')}`);
    if (DRY) {
        console.log(`[dry-run] dump ${FRESH ? 'FULL' : 'warehouse-only'} -> ${dumpPath}, stream into ${DB_NAME}`);
    } else {
        const { bytes } = await exportDb({ outPath: dumpPath, ignoreTables });
        console.log(`[deploy] dump ready: ${dumpPath} (${fmtMB(bytes)} gzipped)`);
        await sshStream(dumpPath, `gunzip | ${MYSQL_ENV} mysql -u ${DB_USER} ${DB_NAME}`, `import ${DB_NAME}`);
    }

    if (FRESH) {
        const truncs = ['SET FOREIGN_KEY_CHECKS=0;', ...INSTANCE_TABLES.map(t => `TRUNCATE TABLE \`${t}\`;`), 'SET FOREIGN_KEY_CHECKS=1;'].join('\n');
        console.log(`[deploy] truncating ${INSTANCE_TABLES.length} instance tables (brand-new server)...`);
        sshInput(`${MYSQL_ENV} mysql -u ${DB_USER} ${DB_NAME}`, truncs);
        await reseedAdmin();
    } else {
        console.log('[deploy] clearing sessions/otp (cache-clear contract)...');
        sshInput(`${MYSQL_ENV} mysql -u ${DB_USER} ${DB_NAME}`, 'TRUNCATE TABLE sessions;\nTRUNCATE TABLE otp_codes;');
    }

    if (!DRY) {
        const check = sshInput(`${MYSQL_ENV} mysql -u ${DB_USER} -N ${DB_NAME}`,
            `SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='${DB_NAME}';\nSELECT COUNT(*) FROM fixtures;\nSELECT COUNT(*) FROM users;`);
        const [tables, fixtures, users] = check.stdout.split('\n');
        console.log(`[deploy] verify: ${tables} tables, ${fixtures} fixtures, ${users} user(s).`);
    }
}

// Seed the admin exactly like scripts/reset-users.js, but with the scrypt hash
// computed LOCALLY from .env.production's PIN_PEPPER/ADMIN_SEED_PIN - no
// dependency on the remote app being installed yet.
async function reseedAdmin() {
    const prodEnvPath = path.join(REPO_ROOT, '.env.server');
    if (!existsSync(prodEnvPath)) die('--fresh needs .env.server (source of the PROD PIN_PEPPER/ADMIN_SEED_PIN for the admin seed).');
    const prod = dotenv.parse(readFileSync(prodEnvPath, 'utf8'));
    const seedPin = prod.ADMIN_SEED_PIN || '0000';
    if (!/^\d{4}$/.test(seedPin)) die(`ADMIN_SEED_PIN in .env.server must be exactly 4 digits (got "${seedPin}").`);
    if (!prod.PIN_PEPPER) console.warn('[deploy] WARN: .env.server has no PIN_PEPPER - admin PIN will be salt-only.');
    const { hashPin } = await import('../src/auth-rules.js');
    const hash = hashPin(seedPin, { pepper: prod.PIN_PEPPER || '' });
    const sql = `INSERT INTO users (id, name, role, phone, phone_region, phone_code, phone_carrier, phone_verified, is_active, must_change_pin, pin_hash)`
        + ` VALUES (1, 'Administrator', 'admin', '+254799944004', 'KE', '254', 'Safaricom', 1, 1, 1, '${hash}');`;
    console.log('[deploy] reseeding admin +254799944004 (must_change_pin=1, PROD pepper)...');
    sshInput(`${MYSQL_ENV} mysql -u ${DB_USER} ${DB_NAME}`, sql);
}

async function stepApp(rel) {
    console.log(`\n[deploy] === APP -> ${APP_DIR} ===`);
    if (!rel) die('no complete release artifact set in release/ - run: npm run package:deploy');
    ssh(`mkdir -p ${TMP_DIR} ${APP_DIR}`);
    await sshStream(rel.app, `cat > ${TMP_DIR}/app.zip`, `upload ${path.basename(rel.app)}`);
    console.log('[deploy] extracting backend...');
    ssh(`unzip -oq ${TMP_DIR}/app.zip -d ${APP_DIR}`);

    const prodEnvPath = path.join(REPO_ROOT, '.env.server');
    const envExists = !DRY && ssh(`test -f ${APP_DIR}/.env && echo yes || echo no`).stdout === 'yes';
    if (existsSync(prodEnvPath) && (!envExists || has('--force-env'))) {
        await sshStream(prodEnvPath, `cat > ${APP_DIR}/.env`, 'upload .env (production)');
    } else if (envExists) {
        console.log('[deploy] remote .env exists - left untouched (use --force-env to overwrite).');
    }

    console.log('[deploy] remote npm install --omit=dev (this can take a few minutes)...');
    ssh(`export PATH=${NODE_PATH_PREFIX}:$PATH; cd ${APP_DIR} && npm install --omit=dev --no-audit --no-fund --loglevel=error`, { capture: false });
    const check = ssh(`export PATH=${NODE_PATH_PREFIX}:$PATH; cd ${APP_DIR} && node -e "console.log(require('./package.json').version)" && ls node_modules | wc -l`);
    console.log(`[deploy] verify: remote app version ${check.stdout.replace('\n', ', ')} node_modules entries.`);
}

async function stepWeb(rel) {
    console.log(`\n[deploy] === WEB -> ${WEB_DIR} ===`);
    if (!rel) die('no complete release artifact set in release/ - run: npm run package:deploy');
    ssh(`mkdir -p ${TMP_DIR}`);
    await sshStream(rel.web, `cat > ${TMP_DIR}/web.zip`, `upload ${path.basename(rel.web)}`);

    // Backup: v<prev>-web.tar.gz per the owner's naming; timestamp suffix when
    // taken already. prev = highest oddspro-app-v* on the host that isn't us.
    const listed = ssh(`ls -1d ${REMOTE_HOME}/oddspro-app-v* 2>/dev/null || true`).stdout;
    const prev = listed.split('\n').map(l => l.match(/oddspro-app-v([\d.]+?)\/?$/)?.[1]).filter(v => v && v !== version)
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).pop();
    let backup = `${REMOTE_HOME}/${prev ? `v${prev}-web` : 'web-backup'}.tar.gz`;
    if (!DRY && ssh(`test -f ${backup} && echo yes || echo no`).stdout === 'yes') {
        backup = backup.replace(/\.tar\.gz$/, `-${new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '_')}.tar.gz`);
    }
    console.log(`[deploy] backing up public_html -> ${backup} ...`);
    ssh(`tar -czf ${backup} -C ${WEB_DIR} .`);
    console.log('[deploy] wiping public_html and extracting the new build...');
    ssh(`find ${WEB_DIR} -mindepth 1 -delete && unzip -oq ${TMP_DIR}/web.zip -d ${WEB_DIR}`);
    const check = ssh(`ls ${WEB_DIR} | head -10; test -f ${WEB_DIR}/index.html && echo INDEX_OK`);
    console.log(`[deploy] verify:\n${check.stdout}`);
}

// ---- run --------------------------------------------------------------------
console.log(`[deploy] target ${SSH_TARGET}  version v${version}  db ${DB_NAME}${DRY ? '  (DRY RUN)' : ''}`);
const rel = latestRelease();
if (rel) console.log(`[deploy] release stamp ${rel.stamp}`);
if (doDb) await stepDb();
if (doApp) await stepApp(rel);
if (doWeb) await stepWeb(rel);
console.log('\n[deploy] done.');
