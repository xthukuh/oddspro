import { useState } from 'react';
import { useSession } from './SessionProvider.jsx';
import AuthShell, { inputCls, btnCls, linkCls, FormError, FormNotice } from './AuthShell.jsx';
import PhoneField from './PhoneField.jsx';
import Field from '../components/Field.jsx';
import useCooldown from './useCooldown.js';

// M13 self-service Forgot PIN (purpose='pin_reset'). Step 1 sends a reset code
// to the phone (the server answers generically for unknown numbers - no
// existence oracle); step 2 takes the code + a new PIN and signs the user in
// (resetPin adopts the fresh session; every old session is revoked
// server-side). When the carrier verifiably can't deliver the SMS
// (delivery_failed on a re-send), a "send to the email on file" option
// appears - the server only ever targets the STORED address here, so there's
// no email input in this unauthenticated flow.
export default function ForgotPinView() {
    const { forgotPin, resetPin, openAuth } = useSession();
    const cooldown = useCooldown();
    const [step, setStep] = useState('phone'); // 'phone' | 'code'
    const [phone, setPhone] = useState('');
    const [code, setCode] = useState('');
    const [pin, setPin] = useState('');
    const [pinConfirm, setPinConfirm] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const [notice, setNotice] = useState(null);
    const [emailOffer, setEmailOffer] = useState(null); // masked address hint or null

    async function send(channel = 'sms') {
        if (busy || cooldown.active) return;
        setBusy(true);
        setError(null);
        setNotice(null);
        try {
            const r = await forgotPin(phone, channel);
            cooldown.start(r.retry_after_seconds);
            if (r.delivery_failed) {
                setEmailOffer(r.email_hint ?? null);
                setError(r.email_hint
                    ? "Texts to this number aren't being delivered - send the code to the email on file instead."
                    : "Texts to this number aren't being delivered and no email is on file - ask an admin for a PIN reset.");
            } else if (r.reused) {
                setNotice('Your last code is still valid - check your messages.');
            } else {
                // Generic either way - an unknown number gets the same answer.
                setNotice(channel === 'email'
                    ? `Code sent to ${r.email_hint ?? 'the email on file'}.`
                    : 'If that number is registered, we sent it a code.');
            }
            setStep('code');
        } catch (err) {
            cooldown.start(err.body?.retry_after_seconds);
            setError(err.message);
        } finally {
            setBusy(false);
        }
    }

    async function submitPhone(e) {
        e.preventDefault();
        if (!phone) return;
        await send('sms');
    }

    async function submitReset(e) {
        e.preventDefault();
        if (busy || !code) return;
        if (pin !== pinConfirm) {
            setError('New PINs do not match');
            return;
        }
        setBusy(true);
        setError(null);
        setNotice(null);
        try {
            await resetPin({ phone, code, pin, pin_confirm: pinConfirm }); // success adopts the session + closes the view
        } catch (err) {
            const left = err.body?.attempts_left;
            setError(left != null && left > 0 ? `${err.message} - ${left} attempt${left === 1 ? '' : 's'} left` : err.message);
            setBusy(false);
        }
    }

    const pinRow = 'flex-1 min-w-0 bg-surface border border-separator text-label rounded-[10px] h-11 px-3 text-[15px] outline-none focus:border-accent';

    return (
        <AuthShell
            title="Forgot your PIN?"
            subtitle={step === 'phone'
                ? "Enter your phone number and we'll send you a reset code."
                : 'Enter the code you received and choose a new PIN.'}
            footer={<button type="button" className={linkCls} onClick={() => openAuth('signin')}>Back to sign in</button>}
        >
            {step === 'phone' ? (
                <form onSubmit={submitPhone} className="flex flex-col gap-3.5">
                    <Field label="Phone number" htmlFor="forgot-phone">
                        <PhoneField id="forgot-phone" value={phone} onChange={setPhone} autoFocus />
                    </Field>
                    <FormError>{error}</FormError>
                    <button type="submit" className={btnCls} disabled={busy || !phone}>
                        {busy ? 'Sending…' : 'Send reset code'}
                    </button>
                </form>
            ) : (
                <form onSubmit={submitReset} className="flex flex-col gap-3.5">
                    <Field label="Reset code" htmlFor="forgot-code">
                        <input
                            id="forgot-code" type="text" inputMode="numeric" autoComplete="one-time-code"
                            maxLength={10} placeholder="Code" className={inputCls + ' tracking-[0.3em] text-center'}
                            value={code} onChange={e => setCode(e.target.value.replace(/\D/g, ''))} autoFocus
                        />
                    </Field>
                    <Field label="New PIN">
                        <div className="flex gap-2.5">
                            <input
                                aria-label="New PIN" type="password" inputMode="numeric" autoComplete="new-password"
                                maxLength={4} placeholder="PIN" className={pinRow} value={pin}
                                onChange={e => setPin(e.target.value.replace(/\D/g, ''))}
                            />
                            <input
                                aria-label="Confirm new PIN" type="password" inputMode="numeric" autoComplete="new-password"
                                maxLength={4} placeholder="Confirm" className={pinRow} value={pinConfirm}
                                onChange={e => setPinConfirm(e.target.value.replace(/\D/g, ''))}
                            />
                        </div>
                    </Field>
                    <FormError>{error}</FormError>
                    <FormNotice>{notice}</FormNotice>
                    <button type="submit" className={btnCls}
                        disabled={busy || code.length < 4 || pin.length !== 4 || pinConfirm.length !== 4}>
                        {busy ? 'Resetting…' : 'Reset PIN & sign in'}
                    </button>
                    <div className="flex items-center justify-between text-sm">
                        <button type="button" className={`${linkCls} disabled:opacity-40 disabled:no-underline disabled:cursor-default`}
                            onClick={() => send('sms')} disabled={busy || cooldown.active}>
                            {cooldown.active ? `Resend in ${cooldown.seconds}s` : 'Resend code'}
                        </button>
                        <button type="button" className={linkCls} onClick={() => { setStep('phone'); setError(null); setNotice(null); }}>
                            Wrong number?
                        </button>
                    </div>
                    {emailOffer && (
                        <div className="pt-3 border-t border-separator flex flex-col gap-2">
                            <div className="text-[13px] text-label-2">SMS not arriving?</div>
                            <button type="button" className={btnCls}
                                onClick={() => send('email')} disabled={busy || cooldown.active}>
                                Send code to {emailOffer}
                            </button>
                        </div>
                    )}
                </form>
            )}
        </AuthShell>
    );
}
