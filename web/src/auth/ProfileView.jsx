import { useState } from 'react';
import { useSession } from './SessionProvider.jsx';
import AuthShell, { inputCls, btnCls, linkCls, FormError, FormNotice } from './AuthShell.jsx';
import Field from '../components/Field.jsx';

// Edit profile: display name + optional PIN change (current PIN required by
// the server). Also serves the FORCED first-login PIN change (`forced`,
// AuthGate): the seeded admin ships with must_change_pin=1 and the server
// 403s everything else until a new PIN lands (H4) - so in forced mode the PIN
// fields are the point, there's no close, and sign-out stays the escape hatch.
export default function ProfileView({ forced = false }) {
    const { user, updateProfile, logout, closeAuth } = useSession();
    const [name, setName] = useState(user?.name ?? '');
    const [currentPin, setCurrentPin] = useState('');
    const [pin, setPin] = useState('');
    const [pinConfirm, setPinConfirm] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const [notice, setNotice] = useState(null);

    const changingPin = forced || pin.length > 0 || pinConfirm.length > 0 || currentPin.length > 0;

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
            }
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
                <FormError>{error}</FormError>
                <FormNotice>{notice}</FormNotice>
                <button type="submit" className={btnCls}
                    disabled={busy || (changingPin && (currentPin.length !== 4 || pin.length !== 4 || pinConfirm.length !== 4))}>
                    {busy ? 'Saving…' : forced ? 'Set new PIN' : 'Save'}
                </button>
            </form>
        </AuthShell>
    );
}
