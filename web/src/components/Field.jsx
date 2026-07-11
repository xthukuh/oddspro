// Reusable form-field wrapper (E1): a visible label above its control with an
// optional visible hint below it - so the guidance touch users can't hover for
// is always on screen. `inline` puts the label beside the control for compact
// rows; the default stacks them. Pass the control(s) as children.
export default function Field({ label, hint, htmlFor, inline = false, className = '', children }) {
    return (
        <div className={`${inline ? 'flex items-center gap-2' : 'flex flex-col gap-1'} ${className}`}>
            {label && <label htmlFor={htmlFor} className="text-xs text-label-2">{label}</label>}
            {children}
            {hint && <span className="text-[11px] leading-snug text-label-3">{hint}</span>}
        </div>
    );
}
