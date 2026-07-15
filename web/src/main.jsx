import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import HumanGate from './HumanGate.jsx';
import SessionProvider from './auth/SessionProvider.jsx';
import AuthGate from './auth/AuthGate.jsx';
import './index.css';

// SessionProvider hydrates a stored session (GET /api/auth/me) and AuthGate
// overlays the auth views; both are always mounted - guests see the app
// exactly as before. The bot-protection gate stays opt-in at build time
// (VITE_HUMAN_POW=1, paired with the server's HUMAN_POW_ENABLED) and wraps
// OUTERMOST: the PoW must have minted X-Human-Token before SessionProvider's
// /api/auth/me fires, or hydration would 401 behind an enforcing server.
const gated = import.meta.env.VITE_HUMAN_POW === '1' || import.meta.env.VITE_HUMAN_POW === 'true';
const tree = <SessionProvider><AuthGate><App /></AuthGate></SessionProvider>;
const Root = gated ? <HumanGate>{tree}</HumanGate> : tree;

createRoot(document.getElementById('root')).render(
    <StrictMode>{Root}</StrictMode>,
);
