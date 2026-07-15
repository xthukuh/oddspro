import PhoneInput from 'react-phone-number-input';
import { parsePhoneNumberFromString } from 'libphonenumber-js';
import 'react-phone-number-input/style.css';

// International phone control (react-phone-number-input): country select +
// national-format input, emitting one E.164 string. Kenya-first per the user
// base; the calling code is select-driven (not hand-typed) so the E.164 value
// stays parseable. Styled via the .op-phone rules in index.css (token palette).
//
//   value          E.164 string ('' when empty)
//   onChange(v)    fresh E.164 string ('' when cleared)
//   onCountryChange(iso2)  optional - parents keep it as the fallback region
export default function PhoneField({ value, onChange, onCountryChange, id, disabled, autoFocus }) {
    return (
        <PhoneInput
            id={id}
            international
            countryCallingCodeEditable={false}
            defaultCountry="KE"
            value={value || undefined}
            onChange={v => onChange(v || '')}
            onCountryChange={c => onCountryChange?.(c || '')}
            disabled={disabled}
            autoFocus={autoFocus}
            className="op-phone"
        />
    );
}

// Split an E.164 value into the { phone, phone_region, phone_code } trio the
// signup/change-phone APIs validate (region = 2-letter ISO, code = calling
// code digits). `fallbackRegion` covers calling codes shared across regions
// (e.g. +1) where libphonenumber can't pin the country - the select's current
// country is the honest answer there.
export function phoneParts(e164, fallbackRegion = 'KE') {
    const parsed = parsePhoneNumberFromString(e164 || '');
    return {
        phone: e164 || '',
        phone_region: parsed?.country || fallbackRegion,
        phone_code: parsed?.countryCallingCode || '',
    };
}
