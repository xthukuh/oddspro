import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

// External kill-switch: the mere EXISTENCE of a `.HALT` file in the app root
// gracefully stops the serve process. Motivation: cPanel's Node app "Stop"
// action sometimes fails to kill the process - dropping a file over FTP/File
// Manager always works. Two enforcement points (both in server.js):
//   - boot: a present .HALT refuses to start (exit 1). Under a Passenger
//     auto-respawn loop this is the mechanism, not a bug - respawn -> refuse
//     -> exit repeats until the platform marks the app errored, which IS the
//     desired stopped state. Delete the file to boot normally.
//   - runtime: an own 30s unref'd watcher (deliberately NOT the auto-refresh
//     tick - AUTO_REFRESH_ENABLED=0 must not disable the kill-switch).
// The path anchors to process.cwd(), which is the app root both under
// Passenger and under npm scripts run from the repo root.

export const HALT_FILE = resolve(process.cwd(), '.HALT');

// Injectable existence check so tests never touch the real fs. A throwing
// probe reads as "no halt" - a broken fs must not take the server down.
export function haltRequested(existsFn = existsSync) {
    try {
        return Boolean(existsFn(HALT_FILE));
    } catch {
        return false;
    }
}

let timer = null;

// Watch for the file and fire `onHalt` exactly once. unref'd - the watcher
// alone must never hold the process open.
export function startHaltWatch(onHalt, intervalMs = 30_000) {
    if (timer) return;
    timer = setInterval(() => {
        if (!haltRequested()) return;
        stopHaltWatch();
        console.error(`[halt] ${HALT_FILE} detected - shutting down gracefully (delete the file to allow restarts).`);
        onHalt();
    }, intervalMs);
    timer.unref?.();
}

export function stopHaltWatch() {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
}
