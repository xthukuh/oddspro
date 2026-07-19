// Shared helpers used by all fetchers (extracted from betpawa.js/betika.js).
import { effective } from './settings.js';

// Verbose timestamped logging, no-op unless DEBUG is on (.env default or the
// admin settings override - late-read per call, M6) - the primary
// diagnostic channel on hosts with no SSH/live tailing (e.g. cPanel cron).
export function debugLog(...args) {
    if (!effective('DEBUG')) return;
    const t = new Date().toISOString().substring(11, 23); // HH:mm:ss.sss
    console.debug(`[dbg ${t}]`, ...args);
}

// Helper - Get positive integer (returns `undefined` when invalid)
export function _pint(value) {
    return Number.isInteger(value = Number(value)) && value >= 0 ? value : undefined;
}

// Helper - Get `Date` instance (returns `new Date()` when invalid)
export function _date(value, set_hours_=undefined) {
    const date = value instanceof Date && !isNaN(value.getTime())
    ? value
    : value
    && !['today', 'now'].includes(String(value).toLowerCase())
    && !isNaN((value = new Date(value)).getTime())
    ? value : new Date();
    const sh = _pint(set_hours_);
    if (!isNaN(sh)) date.setHours(sh);
    return date;
}

// Helper - Get date timestamp in `YYYY-MM-DD HH:mm:ss` format
export function _dtime(value) {
    const d = _date(value);
    const _pad = v => String(v).padStart(2,'0');
    return [
        [d.getFullYear(), d.getMonth() + 1, d.getDate()].map(_pad).join('-'),
        [d.getHours(), d.getMinutes(), d.getSeconds()].map(_pad).join(':'),
    ].join(' ');
}

// Batch progress logger - returns a tick(total) to call once per completed
// item; logs every `step` completions and on the final one.
export function _progress(label, step = 25) {
    let done = 0;
    return total => {
        done++;
        if (done % step === 0 || done === total) console.debug(`${label} ${done}/${total}...`);
    };
}

// Runs batch promises in parallel and returns results buffer.
export async function _batch(list, each, parallel=5) {
    if (!Array.isArray(list)) throw new TypeError('Invalid batch list array.');
    if ('function' !== typeof each) throw new TypeError('Invalid batch each function.');
    parallel = Number.isInteger(parallel = Number(parallel)) && parallel > 0 ? parallel : 5;
    const arr = list.slice(0), len = arr.length, buffer = [];
    let i = -1, pending = 0, abort = 0, error = undefined;
    return new Promise((resolve, reject) => {
        const _next = () => {
            if (abort) {
                if (abort < 0) return;
                abort = -1;
                return reject(error);
            }
            if (!arr.length) {
                // Only resolve once in-flight tasks have also drained.
                if (!pending) resolve(buffer);
                return;
            }
            if ((pending + 1) > parallel) return;
            pending++;
            const index = ++i;
            (async () => Promise.resolve(each(arr.shift(), index, len)))()
            .then(async res => buffer[index] = res)
            .catch(e => {
                if (!abort) {
                    abort = 1;
                    error = e;
                    console.warn(`[${index}/${len}] Exception: ${e.code ? `[${e.code}] ` : ''}${e?.message || e}`);
                }
            })
            .finally(() => {
                pending--;
                _next()
            });
            _next();
        };
        _next();
    });
}
