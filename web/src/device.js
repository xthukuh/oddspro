// Lite-device detection, read once at module load. A phone or tablet (no
// hover, coarse pointer) or a Data Saver connection gets the lighter client
// path: no multi-MB localStorage seed, a smaller in-memory day cache, no
// neighbour-day prefetch and no GPU blur. The server's warm keeper already
// answers every day from its cache, so these trade a little revisit latency
// for far less main-thread work, memory and heat on the device.
export const LITE_DEVICE = (() => {
    try {
        const touch = typeof matchMedia === 'function' && matchMedia('(hover: none), (pointer: coarse)').matches;
        const saveData = typeof navigator !== 'undefined' && !!navigator.connection?.saveData;
        return touch || saveData;
    } catch {
        return false;
    }
})();
