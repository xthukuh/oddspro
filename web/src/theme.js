// Theme controller: 'light' (DEFAULT) | 'dark' | 'system'.
//   system -> data-theme removed, so prefers-color-scheme (and the per-theme
//             color-scheme pinned in index.css) follows the OS.
//   light/dark -> data-theme forced; the token blocks AND color-scheme flip,
//             so even native controls (select popups, scrollbars) match.
// Light is the default when nothing is stored (System is one tap away in
// Settings). The FOUC guard in web/index.html applies the saved value before
// first paint - keep this storage key + logic in sync with that inline script.

const LS_THEME = 'oddspro.theme';
export const THEMES = ['system', 'light', 'dark'];
const VALID = new Set(THEMES);

export function getTheme() {
    try {
        const t = localStorage.getItem(LS_THEME);
        return VALID.has(t) ? t : 'light';
    } catch {
        return 'light';
    }
}

// Reflect a theme onto <html data-theme> without persisting.
export function applyTheme(theme) {
    const t = VALID.has(theme) ? theme : 'system';
    const root = document.documentElement;
    if (t === 'system') delete root.dataset.theme;
    else root.dataset.theme = t;
    return t;
}

// Persist + apply. Returns the normalized value the caller stores in state.
export function setTheme(theme) {
    const t = applyTheme(theme);
    try {
        localStorage.setItem(LS_THEME, t);
    } catch {
        /* private mode / no storage - the in-memory apply still holds for the session */
    }
    return t;
}
