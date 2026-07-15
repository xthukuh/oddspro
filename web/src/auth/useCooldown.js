import { useEffect, useState } from 'react';

// Resend-cooldown countdown. The SERVER is the authority (DB-backed 60·n
// backoff; a premature call answers 429 with the corrected value) - this hook
// only renders the wait so the button can disable and count down. Re-arming a
// 1s timeout per tick keeps it StrictMode-safe (no interval to double-start).
export default function useCooldown() {
    const [seconds, setSeconds] = useState(0);

    useEffect(() => {
        if (seconds <= 0) return;
        const id = setTimeout(() => setSeconds(s => Math.max(0, s - 1)), 1000);
        return () => clearTimeout(id);
    }, [seconds]);

    // start(retry_after_seconds) from any auth response/error; 0/garbage clears.
    const start = s => setSeconds(Math.max(0, Math.ceil(Number(s) || 0)));

    return { seconds, active: seconds > 0, start };
}
