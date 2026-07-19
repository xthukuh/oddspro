import { useState } from 'react';
import { useSession } from './SessionProvider.jsx';
import AuthShell, { inputCls, btnCls, linkCls, FormError, FormNotice } from './AuthShell.jsx';
import Field from '../components/Field.jsx';
import LegalModal from '../components/LegalModal.jsx';
import useCooldown from './useCooldown.js';

// Edit profile: display name + optional PIN change (current PIN required by
// the server). Also serves the FORCED first-login PIN change (`forced`,
// AuthGate): the seeded admin ships with must_change_pin=1 and the server
// 403s everything else until a new PIN lands (H4) - so in forced mode the PIN
// fields are the point, there's no close, and sign-out stays the escape hatch.
// M13 critical-change auth: a PIN change additionally needs a texted (or, when
// SMS can't deliver, emailed) confirmation code - "Send code" here requests it
// (purpose='pin_change') and the save carries it as otp_code.
export default function ProfileView({ forced = false }) {
    const { user, updateProfile, pinChangeOtp, logout, closeAuth } = useSession();
    const cooldown = useCooldown();
    const [name, setName] = useState(user?.name ?? '');
    const [currentPin, setCurrentPin] = useState('');
    const [pin, setPin] = useState('');
    const [pinConfirm, setPinConfirm] = useState('');
    const [otpCode, setOtpCode] = useState('');
    const [otpRequested, setOtpRequested] = useState(false);
    const [emailOffer, setEmailOffer] = useState(false);
    const [email, setEmail] = useState(user?.email ?? '');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const [notice, setNotice] = useState(null);
    const [legal, setLegal] = useState(null); // 'terms' | 'privacy' | null

    const changingPin = forced || pin.length > 0 || pinConfirm.length > 0 || currentPin.length > 0;

    async function sendOtp(emailAddr = null) {
        if (busy || cooldown.active) return;
        setBusy(true);
        setError(null);
        setNotice(null);
        try {
            const r = await pinChangeOtp(emailAddr);
            cooldown.start(r.retry_after_seconds);
            setOtpRequested(true);
            if (r.delivery_failed) {
                setEmailOffer(true);
                setError("Texts to your number aren't being delivered - get the code by email instead.");
            } else if (r.sent === false && !r.reused) {
                setEmailOffer(true);
                setError("We couldn't send the code - try again in a moment.");
            } else if (r.reused) {
                setNotice('Your last code is still valid.');
            } else {
                setNotice(emailAddr ? `Code emailed to ${emailAddr}.` : 'Code sent to your phone.');
            }
        } catch (err) {
            cooldown.start(err.body?.retry_after_seconds);
            setError(err.message);
        } finally {
            setBusy(false);
        }
    }

    async function submit(e) {
        e.preventDefault();
        if (busy) return;
        const patch = {};
        if (name.trim() && name.trim() !== user?.name) patch.name = name.trim();
        if (changingPin) {
            if (pin !== pinConfirm) {
                setError('New PINs do not match');
                return;
            }
            patch.pin = pin;
            patch.current_pin = currentPin;
            patch.otp_code = otpCode;
        }
        if (!Object.keys(patch).length) {
            if (!forced) closeAuth();
            return;
        }

        setBusy(true);
        setError(null);
        try {
            await updateProfile(patch);
            // Forced mode: the cleared must_change_pin unmounts this view via
            // AuthGate. Normal mode: confirm briefly, then close.
            if (!forced) {
                setNotice('Saved.');
                setCurrentPin('');
                setPin('');
                setPinConfirm('');
                setOtpCode('');
                setOtpRequested(false);
            }
        } catch (err) {
            setError(err.message);
        } finally {
            setBusy(false);
        }
    }

    // M9: consent saves immediately on toggle rather than waiting for the Save
    // button - an opt-out the user believes they made must not be lost by
    // navigating away.
    async function optOut(next) {
        setBusy(true);
        setError(null);
        try {
            await updateProfile({ sms_opt_out: next });
            setNotice(next ? 'You will no longer receive promotional SMS.' : 'Promotional SMS re-enabled.');
        } catch (err) {
            setError(err.message);
        } finally {
            setBusy(false);
        }
    }

    const pinRow = 'flex-1 min-w-0 bg-surface border border-separator text-label rounded-[10px] h-11 px-3 text-[15px] outline-none focus:border-accent';

    return (
        <AuthShell
            title={forced ? 'Choose a new PIN' : 'Edit profile'}
            subtitle={forced
                ? 'Your account is using a default PIN. Set your own 4-digit PIN to continue.'
                : user?.phone ? `Signed in as ${user.phone}.` : undefined}
            footer={forced
                ? <button type="button" className={linkCls} onClick={() => logout()}>Sign out</button>
                : <button type="button" className={linkCls} onClick={closeAuth}>Back</button>}
        >
            <form onSubmit={submit} className="flex flex-col gap-3.5">
                {!forced && (
                    <Field label="Name" htmlFor="profile-name">
                        <input
                            id="profile-name" type="text" autoComplete="name" maxLength={120}
                            className={inputCls} value={name} onChange={e => setName(e.target.value)}
                        />
                    </Field>
                )}
                <Field label={forced ? 'Current (default) PIN' : 'Current PIN'} htmlFor="profile-current-pin"
                    hint={forced ? undefined : 'Only needed if you want to change your PIN.'}>
                    <input
                        id="profile-current-pin" type="password" inputMode="numeric" autoComplete="current-password"
                        maxLength={4} placeholder="4 digits" className={inputCls} value={currentPin}
                        onChange={e => setCurrentPin(e.target.value.replace(/\D/g, ''))} autoFocus={forced}
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
                {changingPin && (
                    <Field label="Confirmation code" htmlFor="profile-otp"
                        hint="We send a code to confirm it's really you.">
                        <div className="flex gap-2.5">
                            <input
                                id="profile-otp" type="text" inputMode="numeric" autoComplete="one-time-code"
                                maxLength={10} placeholder="Code" className={pinRow} value={otpCode}
                                onChange={e => setOtpCode(e.target.value.replace(/\D/g, ''))}
                            />
                            <button type="button" className={btnCls + ' w-auto shrink-0 px-4'}
                                onClick={() => sendOtp()} disabled={busy || cooldown.active}>
                                {cooldown.active ? `${cooldown.seconds}s` : otpRequested ? 'Resend' : 'Send code'}
                            </button>
                        </div>
                    </Field>
                )}
                {changingPin && emailOffer && (
                    <div className="flex gap-2.5">
                        <input
                            aria-label="Email for the code" type="email" inputMode="email" autoComplete="email"
                            placeholder="you@example.com" className={pinRow} value={email}
                            onChange={e => setEmail(e.target.value)}
                        />
                        <button type="button" className={btnCls + ' w-auto shrink-0 px-4'}
                            onClick={() => sendOtp(email.trim())} disabled={busy || cooldown.active || !email.includes('@')}>
                            Email it
                        </button>
                    </div>
                )}
                <FormError>{error}</FormError>
                <FormNotice>{notice}</FormNotice>
                <button type="submit" className={btnCls}
                    disabled={busy || (changingPin && (currentPin.length !== 4 || pin.length !== 4 || pinConfirm.length !== 4 || otpCode.length < 4))}>
                    {busy ? 'Saving…' : forced ? 'Set new PIN' : 'Save'}
                </button>
            </form>
            {/* M9 SMS consent. Saves on toggle (no Save press): withdrawing
                consent must never be harder than giving it. Verification and
                sign-in codes are unaffected - those are requested, not broadcast. */}
            {!forced && (
                <div className="mt-1 pt-3 border-t border-separator text-[13px] flex items-start justify-between gap-3">
                    <span className="text-label-3">
                        Promotional SMS
                        <span className="block text-[12px] mt-0.5">
                            {user?.sms_opt_out
                                ? 'Off — you will not receive announcements.'
                                : 'On — occasional announcements. Verification codes are always sent.'}
                        </span>
                    </span>
                    <label className="shrink-0 flex items-center gap-1.5 text-label-2 cursor-pointer">
                        <input
                            type="checkbox" className="accent-accent h-4 w-4 cursor-pointer"
                            checked={!user?.sms_opt_out} disabled={busy}
                            onChange={e => optOut(!e.target.checked)}
                        />
                        Receive
                    </label>
                </div>
            )}
            {/* M4 Legal row: the docs, plus the recorded acceptance for accounts
                that signed up under the consent gate (older accounts show none). */}
            {!forced && (
                <div className="mt-1 pt-3 border-t border-separator text-[13px] text-label-2 flex items-center justify-between gap-2">
                    <span className="text-label-3">
                        Legal
                        {user?.terms_version && (
                            <span className="ml-1.5">
                                · accepted v{user.terms_version}
                                {user.terms_accepted_at ? ` on ${new Date(user.terms_accepted_at).toLocaleDateString()}` : ''}
                            </span>
                        )}
                    </span>
                    <span className="shrink-0">
                        <button type="button" className={linkCls} onClick={() => setLegal('terms')}>Terms</button>
                        <span className="mx-1.5 text-label-3">·</span>
                        <button type="button" className={linkCls} onClick={() => setLegal('privacy')}>Privacy</button>
                    </span>
                </div>
            )}
            {legal && <LegalModal doc={legal} onClose={() => setLegal(null)} />}
        </AuthShell>
    );
}
