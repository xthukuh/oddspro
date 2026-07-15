import { useState } from 'react';
import { useSession } from './SessionProvider.jsx';
import AuthShell, { inputCls, btnCls, linkCls, FormError } from './AuthShell.jsx';
import PhoneField, { phoneParts } from './PhoneField.jsx';
import Field from '../components/Field.jsx';

// Create account: name + phone + 4-digit PIN (confirmed). On 201 the session
// is adopted and AuthGate lands on the forced verify overlay - including when
// the OTP SMS failed to send (otp.sent:false): the account is real, the verify
// screen offers resend, and treating it as a failed signup would 409 the retry.
export default function SignUpView() {
    const { signUp, openAuth, closeAuth } = useSession();
    const [name, setName] = useState('');
    const [phone, setPhone] = useState('');
    const [region, setRegion] = useState('KE'); // select fallback for ambiguous codes
    const [pin, setPin] = useState('');
    const [pinConfirm, setPinConfirm] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);

    async function submit(e) {
        e.preventDefault();
        if (busy) return;
        if (pin !== pinConfirm) {
            setError('PINs do not match');
            return;
        }
        setBusy(true);
        setError(null);
        try {
            await signUp({ name: name.trim(), ...phoneParts(phone, region), pin, pin_confirm: pinConfirm });
        } catch (err) {
            setError(err.message);
            setBusy(false);
        }
    }

    const pinCls = 'flex-1 min-w-0 bg-surface border border-separator text-label rounded-[10px] h-11 px-3 text-[15px] outline-none focus:border-accent';

    return (
        <AuthShell
            title="Create account"
            subtitle="We'll text a code to verify your phone number."
            footer={(
                <>
                    Already registered?{' '}
                    <button type="button" className={linkCls} onClick={() => openAuth('signin')}>Sign in</button>
                    <span className="mx-1.5 text-label-3">·</span>
                    <button type="button" className={linkCls} onClick={closeAuth}>Continue as guest</button>
                </>
            )}
        >
            <form onSubmit={submit} className="flex flex-col gap-3.5">
                <Field label="Name" htmlFor="signup-name">
                    <input
                        id="signup-name" type="text" autoComplete="name" maxLength={120}
                        placeholder="Your name" className={inputCls} value={name}
                        onChange={e => setName(e.target.value)} autoFocus
                    />
                </Field>
                <Field label="Phone number" htmlFor="signup-phone">
                    <PhoneField id="signup-phone" value={phone} onChange={setPhone} onCountryChange={c => c && setRegion(c)} />
                </Field>
                <Field label="Choose a 4-digit PIN" hint="You'll sign in with your phone number and this PIN.">
                    <div className="flex gap-2.5">
                        <input
                            aria-label="PIN" type="password" inputMode="numeric" autoComplete="new-password"
                            maxLength={4} placeholder="PIN" className={pinCls} value={pin}
                            onChange={e => setPin(e.target.value.replace(/\D/g, ''))}
                        />
                        <input
                            aria-label="Confirm PIN" type="password" inputMode="numeric" autoComplete="new-password"
                            maxLength={4} placeholder="Confirm" className={pinCls} value={pinConfirm}
                            onChange={e => setPinConfirm(e.target.value.replace(/\D/g, ''))}
                        />
                    </div>
                </Field>
                <FormError>{error}</FormError>
                <button type="submit" className={btnCls}
                    disabled={busy || !name.trim() || !phone || pin.length !== 4 || pinConfirm.length !== 4}>
                    {busy ? 'Creating account…' : 'Create account'}
                </button>
            </form>
        </AuthShell>
    );
}
