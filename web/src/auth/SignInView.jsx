import { useState } from 'react';
import { useSession } from './SessionProvider.jsx';
import AuthShell, { inputCls, btnCls, linkCls, FormError } from './AuthShell.jsx';
import PhoneField from './PhoneField.jsx';
import Field from '../components/Field.jsx';

// Phone + 4-digit PIN sign-in. Success closes the view (SessionProvider);
// an unverified account then lands on the forced verify overlay via AuthGate.
// Lockout/429 messages come from the server verbatim (it is the authority on
// attempts and waits).
export default function SignInView() {
    const { signIn, openAuth, closeAuth } = useSession();
    const [phone, setPhone] = useState('');
    const [pin, setPin] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);

    async function submit(e) {
        e.preventDefault();
        if (busy) return;
        setBusy(true);
        setError(null);
        try {
            await signIn({ phone, pin });
        } catch (err) {
            setError(err.message);
            setBusy(false);
        }
    }

    return (
        <AuthShell
            title="Sign in"
            subtitle="Use the phone number and PIN you registered with."
            footer={(
                <>
                    New here?{' '}
                    <button type="button" className={linkCls} onClick={() => openAuth('signup')}>Create an account</button>
                    <span className="mx-1.5 text-label-3">·</span>
                    <button type="button" className={linkCls} onClick={closeAuth}>Continue as guest</button>
                </>
            )}
        >
            <form onSubmit={submit} className="flex flex-col gap-3.5">
                <Field label="Phone number" htmlFor="signin-phone">
                    <PhoneField id="signin-phone" value={phone} onChange={setPhone} autoFocus />
                </Field>
                <Field label="PIN" htmlFor="signin-pin">
                    <input
                        id="signin-pin" type="password" inputMode="numeric" autoComplete="current-password"
                        maxLength={4} placeholder="4 digits" className={inputCls} value={pin}
                        onChange={e => setPin(e.target.value.replace(/\D/g, ''))}
                    />
                </Field>
                <FormError>{error}</FormError>
                <button type="submit" className={btnCls} disabled={busy || !phone || pin.length !== 4}>
                    {busy ? 'Signing in…' : 'Sign in'}
                </button>
                <div className="text-center text-sm">
                    <button type="button" className={linkCls} onClick={() => openAuth('forgot')}>Forgot your PIN?</button>
                </div>
            </form>
        </AuthShell>
    );
}
