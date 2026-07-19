import { useEffect, useRef, useState } from 'react';
import { useSession } from './SessionProvider.jsx';
import AuthShell, { inputCls, btnCls, linkCls, FormError, FormNotice } from './AuthShell.jsx';
import PhoneField, { phoneParts } from './PhoneField.jsx';
import Field from '../components/Field.jsx';
import useCooldown from './useCooldown.js';

// Forced overlay while a session's phone is unverified (AuthGate). Enter the
// texted code; resend rides the server's 60·n cooldown (a premature call 429s
// with the corrected wait, which re-seeds the countdown); "Wrong number?"
// swaps the phone (unverified accounts only - the server re-sends to the new
// one). M13: when SMS verifiably can't reach the number (delivery_failed) or a
// send fails outright, an email input is revealed - the emailed code completes
// the SAME verification. Sign out is always available so the gate is never a
// trap.
export default function VerifyPhoneView() {
    const { user, verifyOtp, resendOtp, changePhone, logout, otpHint } = useSession();
    const cooldown = useCooldown();
    const [code, setCode] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const [notice, setNotice] = useState(null);
    const [changing, setChanging] = useState(false);
    const [newPhone, setNewPhone] = useState('');
    const [newRegion, setNewRegion] = useState('KE');
    const [emailOffer, setEmailOffer] = useState(false);
    const [email, setEmail] = useState(user?.email ?? '');
    const seededRef = useRef(false);

    // Seed the countdown + notice from the send that got us here (signup /
    // change-phone / an earlier resend) - once, on mount.
    useEffect(() => {
        if (seededRef.current) return;
        seededRef.current = true;
        if (otpHint?.retry_after_seconds) cooldown.start(otpHint.retry_after_seconds);
        if (otpHint && otpHint.sent === false && !otpHint.reused) {
            setError("We couldn't send the code - tap Resend to try again.");
            setEmailOffer(true);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    async function submitCode(e) {
        e.preventDefault();
        if (busy || !code) return;
        setBusy(true);
        setError(null);
        setNotice(null);
        try {
            await verifyOtp(code); // success flips phone_verified -> AuthGate unmounts this view
        } catch (err) {
            const left = err.body?.attempts_left;
            setError(left != null && left > 0 ? `${err.message} - ${left} attempt${left === 1 ? '' : 's'} left` : err.message);
            setBusy(false);
        }
    }

    async function resend() {
        if (busy || cooldown.active) return;
        setBusy(true);
        setError(null);
        setNotice(null);
        try {
            const r = await resendOtp();
            cooldown.start(r.retry_after_seconds);
            if (r.delivery_failed) {
                // The carrier reports the SMS can't be delivered - no code was
                // (re)sent; steer to the email fallback immediately.
                setEmailOffer(true);
                setError("Texts to your number aren't being delivered - get the code by email instead.");
            } else if (r.sent === false && !r.reused) {
                setEmailOffer(true);
                setError("We couldn't send the code - try again in a moment.");
            } else {
                setNotice(r.reused ? 'Your last code is still valid - check your messages.' : 'Code sent.');
            }
        } catch (err) {
            cooldown.start(err.body?.retry_after_seconds);
            setError(err.message);
        } finally {
            setBusy(false);
        }
    }

    async function sendEmail() {
        if (busy || cooldown.active || !email) return;
        setBusy(true);
        setError(null);
        setNotice(null);
        try {
            const r = await resendOtp(email.trim());
            cooldown.start(r.retry_after_seconds);
            if (r.sent === false && !r.reused) setError("We couldn't send the email - check the address and try again.");
            else setNotice(r.reused ? 'Your last code is still valid.' : `Code emailed to ${email.trim()}.`);
        } catch (err) {
            cooldown.start(err.body?.retry_after_seconds);
            setError(err.message);
        } finally {
            setBusy(false);
        }
    }

    async function submitPhone(e) {
        e.preventDefault();
        if (busy || !newPhone) return;
        setBusy(true);
        setError(null);
        setNotice(null);
        try {
            const r = await changePhone(phoneParts(newPhone, newRegion));
            cooldown.start(r.otp?.retry_after_seconds);
            setNotice(r.otp?.sent === false ? "Number updated, but the code didn't send - tap Resend." : 'Code sent to your new number.');
            setChanging(false);
            setNewPhone('');
            setCode('');
        } catch (err) {
            cooldown.start(err.body?.retry_after_seconds);
            setError(err.message);
        } finally {
            setBusy(false);
        }
    }

    return (
        <AuthShell
            title="Verify your phone"
            subtitle={`Enter the code we texted to ${user?.phone ?? 'your phone'}.`}
            footer={<button type="button" className={linkCls} onClick={() => logout()}>Sign out</button>}
        >
            {!changing ? (
                <form onSubmit={submitCode} className="flex flex-col gap-3.5">
                    <Field label="Verification code" htmlFor="verify-code">
                        <input
                            id="verify-code" type="text" inputMode="numeric" autoComplete="one-time-code"
                            maxLength={10} placeholder="Code" className={inputCls + ' tracking-[0.3em] text-center'}
                            value={code} onChange={e => setCode(e.target.value.replace(/\D/g, ''))} autoFocus
                        />
                    </Field>
                    <FormError>{error}</FormError>
                    <FormNotice>{notice}</FormNotice>
                    <button type="submit" className={btnCls} disabled={busy || code.length < 4}>
                        {busy ? 'Checking…' : 'Verify'}
                    </button>
                    <div className="flex items-center justify-between text-sm">
                        <button type="button" className={`${linkCls} disabled:opacity-40 disabled:no-underline disabled:cursor-default`}
                            onClick={resend} disabled={busy || cooldown.active}>
                            {cooldown.active ? `Resend in ${cooldown.seconds}s` : 'Resend code'}
                        </button>
                        <button type="button" className={linkCls} onClick={() => { setChanging(true); setError(null); setNotice(null); }}>
                            Wrong number?
                        </button>
                    </div>
                    {emailOffer && (
                        <div className="pt-3 border-t border-separator flex flex-col gap-2">
                            <div className="text-[13px] text-label-2">Get the code by email instead:</div>
                            <div className="flex gap-2">
                                <input
                                    type="email" inputMode="email" autoComplete="email" placeholder="you@example.com"
                                    className={inputCls + ' flex-1 min-w-0'} value={email}
                                    onChange={e => setEmail(e.target.value)}
                                />
                                <button type="button" className={btnCls + ' w-auto shrink-0 px-4'}
                                    onClick={sendEmail} disabled={busy || cooldown.active || !email.includes('@')}>
                                    Email it
                                </button>
                            </div>
                        </div>
                    )}
                </form>
            ) : (
                <form onSubmit={submitPhone} className="flex flex-col gap-3.5">
                    <Field label="New phone number" htmlFor="verify-new-phone"
                        hint="We'll text the verification code to this number instead.">
                        <PhoneField id="verify-new-phone" value={newPhone} onChange={setNewPhone}
                            onCountryChange={c => c && setNewRegion(c)} autoFocus />
                    </Field>
                    <FormError>{error}</FormError>
                    <button type="submit" className={btnCls} disabled={busy || !newPhone}>
                        {busy ? 'Updating…' : 'Update & send code'}
                    </button>
                    <div className="text-center text-sm">
                        <button type="button" className={linkCls} onClick={() => { setChanging(false); setError(null); }}>
                            Keep {user?.phone ?? 'current number'}
                        </button>
                    </div>
                </form>
            )}
        </AuthShell>
    );
}
