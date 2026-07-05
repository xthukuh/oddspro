import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Dev server on :5173 proxies /api/* to the oddspro API server (:3001).
export default defineConfig({
    plugins: [react(), tailwindcss()],
    server: {
        port: 5173,
        proxy: { '/api': 'http://localhost:3001' },
        // The table imports the shared pure scorer from ../src/db/ (one
        // magic-sort implementation server + client); the dev server's fs
        // guard must allow reads above web/. Build needs no config - Rollup
        // follows relative imports anywhere.
        fs: { allow: ['..'] },
    },
});
