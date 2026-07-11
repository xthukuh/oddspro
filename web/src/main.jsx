import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import HumanGate from './HumanGate.jsx';
import './index.css';

// The bot-protection gate is opt-in at build time (VITE_HUMAN_POW=1, paired with
// the server's HUMAN_POW_ENABLED). Unset -> the app renders directly, exactly as
// before, so local dev and un-gated deployments are unaffected.
const gated = import.meta.env.VITE_HUMAN_POW === '1' || import.meta.env.VITE_HUMAN_POW === 'true';
const Root = gated ? <HumanGate><App /></HumanGate> : <App />;

createRoot(document.getElementById('root')).render(
    <StrictMode>{Root}</StrictMode>,
);
