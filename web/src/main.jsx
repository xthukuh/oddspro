import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import SessionProvider from './auth/SessionProvider.jsx';
import AuthGate from './auth/AuthGate.jsx';
import './index.css';

// SessionProvider hydrates a stored session (GET /api/auth/me) and AuthGate
// overlays the auth views; both are always mounted - guests see the app
// exactly as before.
//
// NOTE: the proof-of-work HumanGate (VITE_HUMAN_POW) that used to wrap this
// tree was removed 2026-07-16 - deprecated as irrelevant at this stage. It was
// opt-in and off by default, so removal changes nothing for any build.
createRoot(document.getElementById('root')).render(
    <StrictMode>
        <SessionProvider><AuthGate><App /></AuthGate></SessionProvider>
    </StrictMode>,
);
